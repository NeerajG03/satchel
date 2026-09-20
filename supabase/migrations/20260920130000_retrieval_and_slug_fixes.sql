begin;

-- Four fixes from reviewing the v2 release against the live database.

-- 1. A NULL gate silenced retrieval completely.
--
-- `p_gate real default 0.67` only applies when the argument is absent. The
-- service sent `p_gate: args.gate ?? null`, and an explicit NULL is not
-- absent, so the filter became `score >= NULL`, which is NULL, which is not
-- true. Every row was dropped. Measured against the two live memories: the
-- same query returned 2 rows with the default and 0 with an explicit null.
--
-- The caller is fixed too, but the function is the right place to make this
-- safe, because "not supplied" and "supplied as nothing" should mean the same
-- thing to every caller that ever exists. The constants live here and nowhere
-- else now.
create or replace function public.search_memories(
  p_query extensions.vector(768),
  p_in_scope uuid default null,
  p_limit integer default 5,
  p_gate real default 0.67,
  p_boost real default 1.1,
  p_exclude uuid[] default '{}'
) returns table(
  id uuid, project_id uuid, statement text, band text, task_id uuid,
  score real, matched integer, in_scope integer
) language sql stable security invoker set search_path = '' as $$
  with settings as (
    select coalesce(p_gate, 0.67::real) as gate,
           coalesce(p_boost, 1.1::real) as boost,
           greatest(coalesce(p_limit, 5), 0) as cap,
           coalesce(p_exclude, '{}'::uuid[]) as excluded
  ), visible as (
    select m.id, m.project_id, m.statement, m.band, m.task_id,
      (1 - (m.embedding OPERATOR(extensions.<=>) p_query))::real
        * case when p_in_scope is not null and m.project_id = p_in_scope
               then s.boost else 1 end as score
    from public.memories m, settings s
    where m.embedding is not null
      and not (m.id = any(s.excluded))
  ), scored as (
    select v.*, count(*) over () as in_scope,
      count(*) filter (where v.score >= (select gate from settings)) over () as matched
    from visible v
  )
  select id, project_id, statement, band, task_id, score,
    matched::integer, in_scope::integer
  from scored
  where score >= (select gate from settings)
  order by score desc, id
  limit (select cap from settings);
$$;

-- 2. A slug shorter than three characters failed its own check.
--
-- slugify only falls back to 'item' when the result is empty, so a project
-- named "Go" produced "go" and then failed projects_slug_check. Confirmed on
-- the live database: create_project(..., 'Go', ...) raised 23514 from inside
-- the function, which is not something a person can act on.
--
-- The minimum was the wrong rule rather than the wrong implementation. "go",
-- "ui" and "qa" are exactly the slugs someone would choose, and a slug only
-- has to be unique per user and typeable. The regex already forbids empty and
-- forbids junk, so the length floor is dropped and only the ceiling stays.
alter table public.projects drop constraint projects_slug_check;
alter table public.projects add constraint projects_slug_check
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40);
alter table public.tasks drop constraint tasks_slug_check;
alter table public.tasks add constraint tasks_slug_check
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40);

-- 3. A collision suffix could produce a double hyphen.
--
-- The candidate was built by truncating to 36 characters and appending
-- '-' || suffix, with no attention to what the 36th character was. A title
-- like "Fix the corner leak where the shell background paints" truncates to
-- something ending in a hyphen, giving "...-shell--2", which does not match
-- the slug pattern and fails the check. Trimming the truncation fixes it, and
-- the trim can never empty the string because slugify already removed leading
-- and trailing hyphens, so the first character is alphanumeric.
create or replace function public.default_slug() returns trigger
language plpgsql set search_path = '' as $$
declare base text; candidate text; suffix integer := 1; fields jsonb;
begin
  if new.slug is not null then return new; end if;
  fields := to_jsonb(new);
  base := public.slugify(coalesce(fields->>'title', fields->>'name', 'item'));
  candidate := base;
  loop
    exit when not exists (
      select 1 from public.projects p where p.owner_id = new.owner_id and p.slug = candidate
      union all
      select 1 from public.tasks t where t.owner_id = new.owner_id and t.slug = candidate);
    suffix := suffix + 1;
    candidate := trim(both '-' from substring(base from 1 for 36)) || '-' || suffix;
  end loop;
  new.slug := candidate;
  return new;
end;
$$;

-- 4. Renaming could create a collision that inserting would have refused.
--
-- default_slug picks a candidate unique across projects and tasks together,
-- but set_slug relied on the per-table unique indexes alone, so a task could
-- be renamed onto a project's slug. Whether the rule held depended only on
-- which path created the row. Since create_task_with_slug and
-- upsert_project_with_slug both route through here, that was the normal path,
-- not an edge case.
create or replace function public.set_slug(p_kind text, p_id uuid, p_slug text) returns text
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); touched integer;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_kind not in ('project', 'task') then
    raise exception 'Unknown slug kind' using errcode = '23514';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) > 40 then
    raise exception 'A slug is lowercase words joined by hyphens, up to 40 characters' using errcode = '23514';
  end if;
  -- One namespace per person, so the check spans both tables and excludes the
  -- row being renamed, which is what makes renaming to the current slug a
  -- no-op rather than a conflict.
  if exists (
    select 1 from public.projects p
      where p.owner_id = caller and p.slug = p_slug and (p_kind <> 'project' or p.id <> p_id)
    union all
    select 1 from public.tasks t
      where t.owner_id = caller and t.slug = p_slug and (p_kind <> 'task' or t.id <> p_id)
  ) then
    raise exception 'That slug is already in use' using errcode = '23505';
  end if;
  if p_kind = 'project' then
    update public.projects set slug = p_slug where owner_id = caller and id = p_id;
  else
    update public.tasks set slug = p_slug where owner_id = caller and id = p_id;
  end if;
  get diagnostics touched = row_count;
  if touched = 0 then raise exception 'Record not found' using errcode = 'P0002'; end if;
  return p_slug;
end;
$$;

commit;
