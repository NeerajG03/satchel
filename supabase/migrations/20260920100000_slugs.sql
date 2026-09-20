begin;

-- Slugs, because a model copies an identifier and rewrites a title.
--
-- "resume fix-arch-concern" beats pasting a UUID, and a memory row can say what
-- it points at without a join. They are unique per user rather than per project
-- so there is one thing to get right instead of two.
--
-- Supplied on create, never derived from the title: deriving a 40-character
-- slug from "Fix the corner leak where the shell background paints through"
-- produces something nobody would say and that a model matches against worse
-- than the title itself. The generated form below exists only so no row can
-- ever lack a slug, for the backfill and for write paths that predate this.

create function public.slugify(p_text text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(
    substring(
      trim(both '-' from regexp_replace(lower(btrim(p_text)), '[^a-z0-9]+', '-', 'g'))
      from 1 for 40),
    ''), 'item');
$$;

alter table public.projects add column slug text;
alter table public.tasks add column slug text;

-- Backfill. A collision takes a numeric suffix rather than failing the
-- migration, and the user can rename afterwards.
do $$
declare row record; candidate text; suffix integer;
begin
  for row in select owner_id, id, name from public.projects order by created_at, id loop
    candidate := public.slugify(row.name); suffix := 1;
    while exists (select 1 from public.projects p where p.owner_id = row.owner_id and p.slug = candidate) loop
      suffix := suffix + 1;
      candidate := substring(public.slugify(row.name) from 1 for 36) || '-' || suffix;
    end loop;
    update public.projects set slug = candidate where id = row.id;
  end loop;
  for row in select owner_id, id, title from public.tasks order by created_at, id loop
    candidate := public.slugify(row.title); suffix := 1;
    while exists (select 1 from public.tasks t where t.owner_id = row.owner_id and t.slug = candidate) loop
      suffix := suffix + 1;
      candidate := substring(public.slugify(row.title) from 1 for 36) || '-' || suffix;
    end loop;
    update public.tasks set slug = candidate where id = row.id;
  end loop;
end;
$$;

alter table public.projects
  alter column slug set not null,
  add constraint projects_slug_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 40);
alter table public.tasks
  alter column slug set not null,
  add constraint tasks_slug_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 40);
create unique index projects_owner_slug on public.projects(owner_id, slug);
create unique index tasks_owner_slug on public.tasks(owner_id, slug);

-- Nothing can be created without a slug, whichever path created it.
create function public.default_slug() returns trigger
language plpgsql set search_path = '' as $$
declare base text; candidate text; suffix integer := 1; fields jsonb;
begin
  if new.slug is not null then return new; end if;
  -- One trigger serves both tables, and they do not share a label column:
  -- a task has a title, a project has a name. Reading through jsonb keeps this
  -- to one function instead of two that could drift.
  fields := to_jsonb(new);
  base := public.slugify(coalesce(fields->>'title', fields->>'name', 'item'));
  candidate := base;
  loop
    exit when not exists (
      select 1 from public.projects p where p.owner_id = new.owner_id and p.slug = candidate
      union all
      select 1 from public.tasks t where t.owner_id = new.owner_id and t.slug = candidate);
    suffix := suffix + 1;
    candidate := substring(base from 1 for 36) || '-' || suffix;
  end loop;
  new.slug := candidate;
  return new;
end;
$$;
create trigger default_project_slug before insert on public.projects
  for each row execute function public.default_slug();
create trigger default_task_slug before insert on public.tasks
  for each row execute function public.default_slug();

-- One definer routine owns slug changes, so the column never becomes writable
-- directly and ownership is checked in one place.
create function public.set_slug(p_kind text, p_id uuid, p_slug text) returns text
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); touched integer;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) not between 3 and 40 then
    raise exception 'A slug is lowercase words joined by hyphens, 3 to 40 characters' using errcode = '23514';
  end if;
  if p_kind = 'project' then
    update public.projects set slug = p_slug where owner_id = caller and id = p_id;
  elsif p_kind = 'task' then
    update public.tasks set slug = p_slug where owner_id = caller and id = p_id;
  else
    raise exception 'Unknown slug kind' using errcode = '23514';
  end if;
  get diagnostics touched = row_count;
  if touched = 0 then raise exception 'Record not found' using errcode = 'P0002'; end if;
  return p_slug;
end;
$$;

-- Thin wrappers so a create and its slug are one round trip and one
-- transaction: a slug collision rolls the create back rather than leaving a
-- task named after its title. The underlying routines are untouched, so their
-- idempotency and grant checks stay in exactly one place.
create function public.create_task_with_slug(
  p_slug text, p_request_id uuid, p_id uuid, p_project_id uuid, p_title text,
  p_outcome text, p_why text, p_done_when text[], p_next_action text, p_priority text
) returns setof public.tasks language plpgsql security invoker set search_path = '' as $$
declare created public.tasks;
begin
  select * into created from public.create_task(
    p_request_id, p_id, p_project_id, p_title, p_outcome, p_why,
    p_done_when, p_next_action, p_priority) limit 1;
  perform public.set_slug('task', created.id, p_slug);
  return query select * from public.tasks where id = created.id;
end;
$$;

create function public.upsert_project_with_slug(
  p_slug text, p_request_id uuid, p_project_id uuid, p_expected_revision bigint,
  p_name text, p_brief text, p_repository_action text default 'unchanged',
  p_repository text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare response jsonb;
begin
  response := public.upsert_project(p_request_id, p_project_id, p_expected_revision,
    p_name, p_brief, p_repository_action, p_repository);
  perform public.set_slug('project', p_project_id, p_slug);
  return jsonb_set(response, '{project,slug}', to_jsonb(p_slug));
end;
$$;

revoke execute on function public.slugify(text), public.default_slug(),
  public.set_slug(text,uuid,text),
  public.create_task_with_slug(text,uuid,uuid,uuid,text,text,text,text[],text,text),
  public.upsert_project_with_slug(text,uuid,uuid,bigint,text,text,text,text) from public, anon;
grant execute on function public.slugify(text), public.set_slug(text,uuid,text),
  public.create_task_with_slug(text,uuid,uuid,uuid,text,text,text,text[],text,text),
  public.upsert_project_with_slug(text,uuid,uuid,bigint,text,text,text,text) to authenticated;

-- task_planning selects t.*, which expanded to the column list as it stood when
-- the view was created, so it cannot see the new column. Replacing it is the
-- only way to expose the slug, and the definition is otherwise unchanged.
drop view public.task_planning;
create view public.task_planning with (security_invoker = true) as
select
  t.*,
  (
    select p.parent_task_id
    from public.task_parent_edges p
    where p.owner_id = t.owner_id and p.child_task_id = t.id
  ) as parent_id,
  array(
    select d.depends_on_task_id
    from public.task_dependencies d
    where d.owner_id = t.owner_id and d.task_id = t.id
    order by d.depends_on_task_id
  ) as dependency_ids,
  array(
    select d.depends_on_task_id
    from public.task_dependencies d
    join public.tasks prerequisite
      on prerequisite.owner_id = d.owner_id and prerequisite.id = d.depends_on_task_id
    where d.owner_id = t.owner_id and d.task_id = t.id
      and prerequisite.status <> 'done'
    order by d.depends_on_task_id
  ) as blocked_by_ids,
  (
    select count(*)::integer
    from public.task_parent_edges p
    where p.owner_id = t.owner_id and p.parent_task_id = t.id
  ) as child_count,
  (
    t.status in ('ready', 'in_progress')
    and length(btrim(t.next_action)) > 0
    and not exists (
      select 1
      from public.task_dependencies d
      join public.tasks prerequisite
        on prerequisite.owner_id = d.owner_id and prerequisite.id = d.depends_on_task_id
      where d.owner_id = t.owner_id and d.task_id = t.id
        and prerequisite.status <> 'done'
    )
  ) as actionable
from public.tasks t;

revoke all on public.task_planning from public, anon, authenticated;
grant select on public.task_planning to authenticated;

commit;
