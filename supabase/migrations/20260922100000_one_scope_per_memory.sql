begin;

-- A memory belongs to exactly one project, or to personal. Nothing else.
--
-- The task link was added on the idea that a memory whose task closes should
-- announce a doubt before being used. In production it produced one hint,
-- never shown, and three ways to get the scope wrong:
--
--   save_memory silently moved a memory into the task's project, so one wrong
--   task guess by a small model relocated a rule into a project the user never
--   mentioned. It was `project: task ? taskProject : project` in the router
--   and a scope-agreement check in SQL, which is two places enforcing a rule
--   that only exists because of the link.
--
--   The router made four decisions per item instead of three, and the extra
--   one was the least grounded: an open task list is a list of things being
--   worked on now, and a memory is a thing that stays true.
--
--   The foreign key had to reference (owner_id, id) rather than the scope
--   qualified key, because Postgres refuses ON DELETE SET NULL against a
--   generated column and tasks.scope_key is generated. So the database could
--   not enforce scope agreement and a function had to.
--
-- Removing the link is not the same as refusing to route a work order to a
-- task. That creates a task and no memory and no link, and it stays open.
-- See docs/memory-v2-5-scope.md, R9a.

-- Functions first: each one names the column, and leaving a stale definition
-- behind would fail at call time rather than here.

drop function public.save_memory(uuid, uuid, text, text, text, uuid, text, text);
create function public.save_memory(
  p_id uuid, p_project_id uuid, p_statement text, p_source text default '',
  p_band text default 'said',
  p_name text default null, p_more_info text default ''
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  insert into public.memories(id, project_id, statement, source, band, name, more_info)
    values(p_id, p_project_id, btrim(p_statement), p_source, p_band,
           nullif(btrim(coalesce(p_name, '')), ''), p_more_info)
    on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  -- A retry with the same id and the same payload is the same save. A reused id
  -- carrying anything else is a conflict, never an overwrite.
  if result.id is null
    or result.project_id is distinct from p_project_id
    or result.statement is distinct from btrim(p_statement)
    or result.band is distinct from p_band then
    raise exception 'Memory request conflict' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

drop function public.capture_memory(uuid, text, text, text, text);
create function public.capture_memory(
  p_id uuid, p_statement text, p_source text, p_project_slug text default null
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target_project uuid;
  result public.memories;
begin
  if p_project_slug is not null then
    select id into target_project from public.projects
      where owner_id = caller and slug = p_project_slug;
  end if;
  select * into result from public.save_memory(
    p_id, target_project, p_statement, p_source, 'heard', null, '');
  return result;
end;
$$;

drop function public.list_memories(uuid);
create function public.list_memories(p_project_id uuid)
returns table(id uuid, project_id uuid, statement text, band text,
  name text, has_more_info boolean, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.statement, m.band, m.name,
    length(btrim(m.more_info)) > 0, m.revision, m.updated_at
  from public.memories m
  where m.project_id is not distinct from p_project_id
  order by m.updated_at desc, m.id;
$$;

drop function public.all_memories();
create function public.all_memories()
returns table(id uuid, project_id uuid, statement text, band text,
  name text, has_more_info boolean, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.statement, m.band, m.name,
    length(btrim(m.more_info)) > 0, m.revision, m.updated_at
  from public.memories m
  order by m.updated_at desc, m.id;
$$;

drop function public.search_memories(extensions.vector(768), uuid, integer, real, real, uuid[]);
create function public.search_memories(
  p_query extensions.vector(768),
  p_in_scope uuid default null,
  p_limit integer default 5,
  p_gate real default 0.67,
  p_boost real default 1.1,
  p_exclude uuid[] default '{}'
) returns table(
  id uuid, project_id uuid, statement text, band text,
  score real, matched integer, in_scope integer
) language sql stable security invoker set search_path = '' as $$
  with settings as (
    select coalesce(p_gate, 0.67::real) as gate,
           coalesce(p_boost, 1.1::real) as boost,
           greatest(coalesce(p_limit, 5), 0) as cap,
           coalesce(p_exclude, '{}'::uuid[]) as excluded
  ), visible as (
    select m.id, m.project_id, m.statement, m.band,
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
  select id, project_id, statement, band, score,
    matched::integer, in_scope::integer
  from scored
  where score >= (select gate from settings)
  order by score desc, id
  limit (select cap from settings);
$$;

-- The revision trigger is the one place the column was load bearing for
-- something other than the link: moving a memory between tasks counted as an
-- edit. With no link there is nothing to move.
create or replace function public.stamp_memory_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.statement is not distinct from old.statement
    and new.source is not distinct from old.source
    and new.more_info is not distinct from old.more_info
    and new.name is not distinct from old.name
    and new.band is not distinct from old.band
    and new.project_id is not distinct from old.project_id
  then
    new.revision := old.revision;
    new.updated_at := old.updated_at;
    return new;
  end if;
  new.revision := old.revision + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- The column, its index and its foreign key go together. Nothing is migrated
-- out of it: the link never carried anything a scope does not, and the eight
-- rows in production hold two task ids between them.
alter table public.memories drop column task_id;

grant insert(statement, source, band) on public.memories to authenticated;
grant update(statement, source, band) on public.memories to authenticated;

revoke execute on function
  public.save_memory(uuid,uuid,text,text,text,text,text),
  public.capture_memory(uuid,text,text,text),
  public.list_memories(uuid),
  public.all_memories(),
  public.search_memories(extensions.vector(768),uuid,integer,real,real,uuid[])
  from public, anon;
grant execute on function
  public.save_memory(uuid,uuid,text,text,text,text,text),
  public.capture_memory(uuid,text,text,text),
  public.list_memories(uuid),
  public.all_memories(),
  public.search_memories(extensions.vector(768),uuid,integer,real,real,uuid[])
  to authenticated;

commit;
