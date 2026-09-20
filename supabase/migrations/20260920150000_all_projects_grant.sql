begin;

-- "All projects" used to mean "the projects that existed the moment you
-- clicked". The consent page built the grant with projects.map(p => p.id), so
-- it froze a list of UUIDs. Make a project the next day and the agent you just
-- gave everything to cannot see it, with no error that explains why. That is
-- also why upsert_project has to return grant_required at all: an agent can
-- create a project and then be unable to use it.
--
-- So "every project" becomes a state of the grant rather than a list. The flag
-- is what the person consented to, and it keeps being true about projects that
-- do not exist yet.
--
-- This deliberately changes a rule the security skill used to state outright:
-- there was no all-projects read for agents. It is still an explicit grant
-- flag, still per connection, still revocable, and still nothing by default.
-- What changed is that a person can now choose it on purpose.
--
-- Nothing is backfilled. A connection granted "all" yesterday keeps its frozen
-- list until the person authorizes again and sees what they are agreeing to.
-- Widening an existing grant in a migration would be the same bug as the one
-- being fixed, pointing the other way.
alter table public.agent_connections
  add column all_projects boolean not null default false,
  add column task_all_projects boolean not null default false;

-- A blanket grant covers every project this owner has, now and later. The
-- explicit list stays for the "only these" case and the two never mix: v3
-- stores an empty list alongside the flag, so a stale snapshot can never sit
-- next to it looking authoritative.
create or replace function public.agent_can_access(p_project_id uuid, p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.agent_connections c
    where c.owner_id=auth.uid() and c.client_id=auth.jwt()->>'client_id'
      and c.grant_id::text=auth.jwt()->>'satchel_grant_id' and c.revoked_at is null
      and (not p_write or c.can_write)
      and (case when p_project_id is null then c.personal
                else c.all_projects or p_project_id=any(c.project_ids) end));
$$;

-- Tasks carry their capabilities on the grant row, one row per project, so a
-- blanket grant has no row to read them from. It uses the connection level
-- task_can_write and task_can_upload that the consent page already collects,
-- and read is implied by the flag itself.
--
-- The personal branch is carried over deliberately. Recreating this function
-- from the version in 20260916070509 would silently drop the personal-task
-- scope that 20260916154226 added, which is the "recreating a function reverts
-- an earlier migration" failure this codebase has already had once.
-- Personal is its own flag: a blanket project grant is every project, not
-- everything.
create or replace function private.agent_can_access_tasks(
  p_project_id uuid,
  p_capability text default 'read'
) returns boolean
language sql stable security definer set search_path = '' as $$
  select
    p_capability in ('read', 'write', 'upload')
    and (select auth.uid()) is not null
    and ((select auth.jwt())->>'client_id') is not null
    and exists (
      select 1
      from public.agent_connections c
      where c.owner_id = (select auth.uid())
        and c.client_id = ((select auth.jwt())->>'client_id')
        and c.grant_id::text = ((select auth.jwt())->>'satchel_grant_id')
        and c.revoked_at is null
        and case
          when p_project_id is null then
            c.task_personal
            and case p_capability
              when 'read' then true
              when 'write' then c.task_can_write
              when 'upload' then c.task_can_upload
              else false
            end
          else
            (c.task_all_projects and case p_capability
              when 'read' then true
              when 'write' then c.task_can_write
              when 'upload' then c.task_can_upload
              else false
            end)
            or exists (
              select 1 from public.agent_task_grants g
              where g.owner_id = c.owner_id and g.client_id = c.client_id
                and g.grant_id = c.grant_id and g.project_id = p_project_id
                and case p_capability
                  when 'read' then g.can_read
                  when 'write' then g.can_write
                  when 'upload' then g.can_upload
                  else false
                end
            )
        end
    );
$$;

create function public.authorize_agent_v3(
  p_client_id text,
  p_label text,
  p_personal boolean,
  p_all_projects boolean,
  p_project_ids uuid[],
  p_can_write boolean,
  p_task_personal boolean,
  p_task_all_projects boolean,
  p_task_project_ids uuid[],
  p_task_can_write boolean,
  p_task_can_upload boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  next_grant uuid := gen_random_uuid();
  -- A blanket grant keeps no list. Holding both would leave the Apps page and
  -- agent_connection_status showing a frozen set of names that no longer
  -- decides anything, which is worse than showing none.
  memory_ids uuid[] := case when p_all_projects then '{}'::uuid[] else p_project_ids end;
  task_ids uuid[] := case when p_task_all_projects then '{}'::uuid[] else p_task_project_ids end;
begin
  if auth.uid() is null or auth.jwt()->>'client_id' is not null then
    raise exception 'Companion sign-in required' using errcode = '42501';
  end if;
  if p_project_ids is null or p_task_project_ids is null
    or cardinality(p_project_ids) > 100 or cardinality(p_task_project_ids) > 100
    or array_position(p_project_ids, null) is not null
    or array_position(p_task_project_ids, null) is not null
    or exists (
      select 1 from unnest(p_project_ids || p_task_project_ids) p
      where not exists (
        select 1 from public.projects where id = p and owner_id = auth.uid()
      )
    ) then
    raise exception 'Invalid project selection' using errcode = '42501';
  end if;
  -- A blanket grant is a scope, so it satisfies this on its own.
  if not p_personal and not p_all_projects and cardinality(p_project_ids) = 0
    and not p_task_personal and not p_task_all_projects and cardinality(p_task_project_ids) = 0 then
    raise exception 'Select a memory or task scope' using errcode = '23514';
  end if;

  insert into public.agent_connections(
    owner_id, client_id, label, personal, all_projects, project_ids, can_write,
    task_personal, task_all_projects, task_can_write, task_can_upload, grant_id
  ) values (
    auth.uid(), p_client_id, btrim(p_label), p_personal, p_all_projects, memory_ids, p_can_write,
    p_task_personal, p_task_all_projects, p_task_can_write, p_task_can_upload, next_grant
  )
  on conflict(owner_id, client_id) do update set
    label = excluded.label,
    personal = excluded.personal,
    all_projects = excluded.all_projects,
    project_ids = excluded.project_ids,
    can_write = excluded.can_write,
    task_personal = excluded.task_personal,
    task_all_projects = excluded.task_all_projects,
    task_can_write = excluded.task_can_write,
    task_can_upload = excluded.task_can_upload,
    revoked_at = null,
    grant_id = excluded.grant_id;

  -- Rewritten on every authorization, so a grant never keeps rows from the
  -- previous one. A blanket task grant writes none at all.
  delete from public.agent_task_grants
    where owner_id = auth.uid() and client_id = p_client_id;
  insert into public.agent_task_grants(
    owner_id, client_id, grant_id, project_id, can_read, can_write, can_upload
  )
  select auth.uid(), p_client_id, next_grant, project_id, true,
    p_task_can_write, p_task_can_upload
  from (select distinct unnest(task_ids) project_id) selected;
end;
$$;

-- The older signature now delegates, which matters for more than tidiness: a
-- person re-authorizing through an older client must come back without a
-- blanket grant rather than keeping one the new consent page gave them.
create or replace function public.authorize_agent_v2(
  p_client_id text,
  p_label text,
  p_personal boolean,
  p_project_ids uuid[],
  p_can_write boolean,
  p_task_personal boolean,
  p_task_project_ids uuid[],
  p_task_can_write boolean,
  p_task_can_upload boolean
) returns void
language sql security invoker set search_path = '' as $$
  select public.authorize_agent_v3(
    p_client_id, p_label, p_personal, false, p_project_ids, p_can_write,
    p_task_personal, false, p_task_project_ids, p_task_can_write, p_task_can_upload
  );
$$;

-- The agent has to be able to tell a blanket grant from a list, or it cannot
-- explain its own scope to the person using it.
create or replace function public.agent_connection_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'client_id', c.client_id,
    'label', c.label,
    'personal', c.personal,
    'all_projects', c.all_projects,
    'project_ids', c.project_ids,
    'can_write', c.can_write,
    'task_personal', c.task_personal,
    'task_all_projects', c.task_all_projects,
    'task_project_ids', coalesce((
      select jsonb_agg(g.project_id order by g.project_id)
      from public.agent_task_grants g
      where g.owner_id = c.owner_id and g.client_id = c.client_id
        and g.grant_id = c.grant_id and g.can_read
    ), '[]'::jsonb),
    'task_can_write', c.task_can_write,
    'task_can_upload', c.task_can_upload
  )
  from public.agent_connections c
  where c.owner_id = auth.uid()
    and c.client_id = auth.jwt()->>'client_id'
    and c.grant_id::text = auth.jwt()->>'satchel_grant_id'
    and c.revoked_at is null;
$$;

revoke execute on function public.authorize_agent_v3(
  text, text, boolean, boolean, uuid[], boolean, boolean, boolean, uuid[], boolean, boolean)
  from public, anon;
grant execute on function public.authorize_agent_v3(
  text, text, boolean, boolean, uuid[], boolean, boolean, boolean, uuid[], boolean, boolean)
  to authenticated;

commit;
