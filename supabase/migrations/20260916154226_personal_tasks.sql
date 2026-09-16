begin;

-- Personal tasks are a first-class nullable project scope. Generated scope
-- keys keep every child relationship fully enforced even when project_id is
-- null; no hidden or synthetic project row is required.
alter table public.agent_connections
  add column task_personal boolean not null default false;

alter table public.handoff_resource_refs
  drop constraint handoff_resource_refs_owner_id_project_id_task_id_handoff__fkey,
  drop constraint handoff_resource_refs_owner_id_project_id_task_id_resource_fkey;
alter table public.task_resources
  drop constraint task_resources_owner_id_project_id_task_id_introduced_by_h_fkey,
  drop constraint task_resources_owner_id_project_id_task_id_fkey,
  drop constraint task_resources_owner_id_project_id_task_id_id_key;
alter table public.task_handoffs
  drop constraint task_handoffs_owner_id_project_id_task_id_fkey,
  drop constraint task_handoffs_owner_id_project_id_task_id_id_key;
alter table public.task_events
  drop constraint task_events_owner_id_project_id_task_id_fkey;
alter table public.tasks
  drop constraint tasks_owner_id_project_id_id_key;

alter table public.tasks
  alter column project_id drop not null,
  add column scope_key text generated always as (coalesce(project_id::text, 'personal')) stored;
alter table public.task_handoffs
  alter column project_id drop not null,
  add column scope_key text generated always as (coalesce(project_id::text, 'personal')) stored;
alter table public.task_resources
  alter column project_id drop not null,
  add column scope_key text generated always as (coalesce(project_id::text, 'personal')) stored;
alter table public.handoff_resource_refs
  alter column project_id drop not null,
  add column scope_key text generated always as (coalesce(project_id::text, 'personal')) stored;
alter table public.task_events
  alter column project_id drop not null,
  add column scope_key text generated always as (coalesce(project_id::text, 'personal')) stored;

alter table public.tasks
  add constraint tasks_owner_scope_id_key unique (owner_id, scope_key, id);
alter table public.task_handoffs
  add constraint task_handoffs_owner_scope_task_id_key
    unique (owner_id, scope_key, task_id, id),
  add constraint task_handoffs_owner_scope_task_fkey
    foreign key (owner_id, scope_key, task_id)
    references public.tasks(owner_id, scope_key, id) on delete cascade;
alter table public.task_resources
  add constraint task_resources_owner_scope_task_id_key
    unique (owner_id, scope_key, task_id, id),
  add constraint task_resources_owner_scope_task_fkey
    foreign key (owner_id, scope_key, task_id)
    references public.tasks(owner_id, scope_key, id) on delete cascade,
  add constraint task_resources_owner_scope_task_handoff_fkey
    foreign key (owner_id, scope_key, task_id, introduced_by_handoff_id)
    references public.task_handoffs(owner_id, scope_key, task_id, id);
alter table public.handoff_resource_refs
  add constraint handoff_resource_refs_owner_scope_task_handoff_fkey
    foreign key (owner_id, scope_key, task_id, handoff_id)
    references public.task_handoffs(owner_id, scope_key, task_id, id) on delete cascade,
  add constraint handoff_resource_refs_owner_scope_task_resource_fkey
    foreign key (owner_id, scope_key, task_id, resource_id)
    references public.task_resources(owner_id, scope_key, task_id, id) on delete cascade;
alter table public.task_events
  add constraint task_events_owner_scope_task_fkey
    foreign key (owner_id, scope_key, task_id)
    references public.tasks(owner_id, scope_key, id) on delete cascade;

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
          else exists (
            select 1
            from public.agent_task_grants g
            where g.owner_id = c.owner_id
              and g.client_id = c.client_id
              and g.grant_id = c.grant_id
              and g.project_id = p_project_id
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

-- New consent contract. The previous eight-argument overload remains as a
-- compatibility wrapper and deliberately clears personal-task access.
create function public.authorize_agent_v2(
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
language plpgsql security definer set search_path = '' as $$
declare next_grant uuid := gen_random_uuid();
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
  if not p_personal and cardinality(p_project_ids) = 0
    and not p_task_personal and cardinality(p_task_project_ids) = 0 then
    raise exception 'Select a memory or task scope' using errcode = '23514';
  end if;

  insert into public.agent_connections(
    owner_id, client_id, label, personal, project_ids, can_write,
    task_personal, task_can_write, task_can_upload, grant_id
  ) values (
    auth.uid(), p_client_id, btrim(p_label), p_personal, p_project_ids, p_can_write,
    p_task_personal, p_task_can_write, p_task_can_upload, next_grant
  )
  on conflict(owner_id, client_id) do update set
    label = excluded.label,
    personal = excluded.personal,
    project_ids = excluded.project_ids,
    can_write = excluded.can_write,
    task_personal = excluded.task_personal,
    task_can_write = excluded.task_can_write,
    task_can_upload = excluded.task_can_upload,
    revoked_at = null,
    grant_id = excluded.grant_id;

  delete from public.agent_task_grants
    where owner_id = auth.uid() and client_id = p_client_id;
  insert into public.agent_task_grants(
    owner_id, client_id, grant_id, project_id, can_read, can_write, can_upload
  )
  select auth.uid(), p_client_id, next_grant, project_id, true,
    p_task_can_write, p_task_can_upload
  from (select distinct unnest(p_task_project_ids) project_id) selected;
end;
$$;

create or replace function public.authorize_agent_v2(
  p_client_id text,
  p_label text,
  p_personal boolean,
  p_project_ids uuid[],
  p_can_write boolean,
  p_task_project_ids uuid[],
  p_task_can_write boolean,
  p_task_can_upload boolean
) returns void
language sql security invoker set search_path = '' as $$
  select public.authorize_agent_v2(
    p_client_id, p_label, p_personal, p_project_ids, p_can_write,
    false, p_task_project_ids, p_task_can_write, p_task_can_upload
  );
$$;

create or replace function public.authorize_agent(
  p_client_id text,
  p_label text,
  p_personal boolean,
  p_project_ids uuid[],
  p_can_write boolean
) returns void
language sql security invoker set search_path = '' as $$
  select public.authorize_agent_v2(
    p_client_id, p_label, p_personal, p_project_ids, p_can_write,
    false, '{}'::uuid[], false, false
  );
$$;

create or replace function public.revoke_agent(p_client_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or auth.jwt()->>'client_id' is not null then
    raise exception 'Companion sign-in required' using errcode='42501';
  end if;
  delete from public.agent_task_grants
    where owner_id = auth.uid() and client_id = p_client_id;
  update public.agent_connections
    set revoked_at = now(), grant_id = gen_random_uuid(),
      task_personal = false, task_can_write = false, task_can_upload = false
    where owner_id = auth.uid() and client_id = p_client_id;
end;
$$;

create or replace function public.agent_connection_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'client_id', c.client_id,
    'label', c.label,
    'personal', c.personal,
    'project_ids', c.project_ids,
    'can_write', c.can_write,
    'task_personal', c.task_personal,
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

-- Existing mutation functions used project_id null as an impossible/missing
-- sentinel. Rewrite only those guards, and use null-safe scope comparisons in
-- handoff validation. Each replacement is guarded so drift fails the migration.
do $$
declare
  signature text;
  definition text;
  rewritten text;
begin
  foreach signature in array array[
    'public.update_task(uuid,uuid,bigint,text,text,text,text[],text,text)',
    'public.transition_task(uuid,uuid,bigint,text,text)',
    'public.record_task_handoff(uuid,uuid,uuid,bigint,uuid[],text[],text[],jsonb,text[],text[],text,text,text,text,uuid[])',
    'public.add_task_resource(uuid,uuid,uuid,bigint,text,text,text,text)',
    'public.reserve_task_file(uuid,uuid,uuid,bigint,text,text,text,bigint,text,text)'
  ] loop
    select pg_get_functiondef(to_regprocedure(signature)) into definition;
    rewritten := replace(
      definition,
      'if current_project is null or not private.task_can_access(current_project, ''write'') then',
      'if not found or not private.task_can_access(current_project, ''write'') then'
    );
    rewritten := replace(
      rewritten,
      'if current_project is null or not private.task_can_access(current_project, ''upload'') then',
      'if not found or not private.task_can_access(current_project, ''upload'') then'
    );
    if signature like 'public.record_task_handoff%' then
      rewritten := replace(rewritten, 'h.project_id = current_project',
        'h.project_id is not distinct from current_project');
      rewritten := replace(rewritten, 'r.project_id = current_project',
        'r.project_id is not distinct from current_project');
    end if;
    if rewritten = definition then
      raise exception 'Personal-task rewrite did not match %', signature;
    end if;
    execute rewritten;
  end loop;
end;
$$;

-- A null export scope now means personal tasks. Cross-scope export can be
-- added as an explicit operation later instead of overloading null.
do $$
declare
  definition text;
  rewritten text;
begin
  select pg_get_functiondef('public.export_tasks(uuid)'::regprocedure) into definition;
  rewritten := replace(definition, 'where p_project_id is null or t.project_id = p_project_id',
    'where t.project_id is not distinct from p_project_id');
  rewritten := replace(rewritten, 'where p_project_id is null or h.project_id = p_project_id',
    'where h.project_id is not distinct from p_project_id');
  rewritten := replace(rewritten, 'where p_project_id is null or r.project_id = p_project_id',
    'where r.project_id is not distinct from p_project_id');
  rewritten := replace(rewritten, 'where p_project_id is null or ref.project_id = p_project_id',
    'where ref.project_id is not distinct from p_project_id');
  rewritten := replace(rewritten, 'where p_project_id is null or e.project_id = p_project_id',
    'where e.project_id is not distinct from p_project_id');
  if rewritten = definition then
    raise exception 'Personal-task export rewrite did not match';
  end if;
  execute rewritten;
end;
$$;

revoke execute on function public.authorize_agent_v2(
  text,text,boolean,uuid[],boolean,boolean,uuid[],boolean,boolean
) from public, anon, authenticated;
grant execute on function public.authorize_agent_v2(
  text,text,boolean,uuid[],boolean,boolean,uuid[],boolean,boolean
) to authenticated;

commit;
