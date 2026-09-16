begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter table public.agent_connections
  add column task_can_write boolean not null default false,
  add column task_can_upload boolean not null default false;

create table public.agent_task_grants (
  owner_id uuid not null,
  client_id text not null,
  grant_id uuid not null,
  project_id uuid not null,
  can_read boolean not null default true,
  can_write boolean not null default false,
  can_upload boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (owner_id, client_id, project_id),
  foreign key (owner_id, client_id)
    references public.agent_connections(owner_id, client_id) on delete cascade,
  foreign key (owner_id, project_id)
    references public.projects(owner_id, id) on delete cascade,
  check (can_read or can_write or can_upload)
);

create index agent_task_grants_project
  on public.agent_task_grants(owner_id, project_id, client_id);

alter table public.agent_task_grants enable row level security;
revoke all on public.agent_task_grants from public, anon, authenticated;
grant select on public.agent_task_grants to authenticated;

create policy companion_agent_task_grants_read on public.agent_task_grants
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and ((select auth.jwt())->>'client_id') is null
  );

create function private.agent_can_access_tasks(
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
      join public.agent_task_grants g
        on g.owner_id = c.owner_id
       and g.client_id = c.client_id
       and g.grant_id = c.grant_id
      where c.owner_id = (select auth.uid())
        and c.client_id = ((select auth.jwt())->>'client_id')
        and c.grant_id::text = ((select auth.jwt())->>'satchel_grant_id')
        and c.revoked_at is null
        and g.project_id = p_project_id
        and case p_capability
          when 'read' then g.can_read
          when 'write' then g.can_write
          when 'upload' then g.can_upload
          else false
        end
    );
$$;

create function private.task_can_access(
  p_project_id uuid,
  p_capability text default 'read'
) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and (
    (((select auth.jwt())->>'client_id') is null and p_capability in ('read', 'write', 'upload'))
    or private.agent_can_access_tasks(p_project_id, p_capability)
  );
$$;

create function private.task_actor() returns text
language sql stable security definer set search_path = '' as $$
  select case
    when (select auth.uid()) is null then null
    when ((select auth.jwt())->>'client_id') is null then 'user:' || (select auth.uid())::text
    else 'agent:' || ((select auth.jwt())->>'client_id')
  end;
$$;

revoke execute on function private.agent_can_access_tasks(uuid,text),
  private.task_can_access(uuid,text), private.task_actor()
  from public, anon, authenticated;
grant execute on function private.agent_can_access_tasks(uuid,text),
  private.task_can_access(uuid,text), private.task_actor()
  to authenticated;

create table public.tasks (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null,
  id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  outcome text not null default '' check (length(outcome) <= 1000),
  why text not null default '' check (length(why) <= 4000),
  done_when text[] not null default '{}' check (
    cardinality(done_when) <= 20
    and array_position(done_when, null) is null
  ),
  next_action text not null default '' check (length(next_action) <= 1000),
  status text not null default 'inbox'
    check (status in ('inbox', 'ready', 'in_progress', 'blocked', 'done')),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),
  blocked_reason text not null default '' check (
    length(blocked_reason) <= 2000
    and ((status = 'blocked' and length(btrim(blocked_reason)) > 0)
      or (status <> 'blocked' and blocked_reason = ''))
  ),
  revision bigint not null default 1 check (revision > 0),
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  primary key (owner_id, id),
  unique (owner_id, project_id, id),
  foreign key (owner_id, project_id)
    references public.projects(owner_id, id) on delete cascade,
  check (length(array_to_string(done_when, '')) <= 10000),
  check ((status = 'done' and closed_at is not null)
    or (status <> 'done' and closed_at is null))
);

create index tasks_project_active_updated
  on public.tasks(owner_id, project_id, updated_at desc, id)
  where status <> 'done';
create index tasks_project_status_updated
  on public.tasks(owner_id, project_id, status, updated_at desc, id);

create table public.task_handoffs (
  owner_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  id uuid not null,
  supersedes_ids uuid[] not null default '{}'
    check (cardinality(supersedes_ids) <= 20 and array_position(supersedes_ids, null) is null),
  completed text[] not null default '{}' check (cardinality(completed) <= 50),
  decisions text[] not null default '{}' check (cardinality(decisions) <= 50),
  validation jsonb not null default '[]'::jsonb check (jsonb_typeof(validation) = 'array'),
  remaining text[] not null default '{}' check (cardinality(remaining) <= 50),
  blockers text[] not null default '{}' check (cardinality(blockers) <= 50),
  next_action text not null check (length(btrim(next_action)) between 1 and 1000),
  summary text not null default '' check (length(summary) <= 4000),
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, project_id, task_id, id),
  foreign key (owner_id, project_id, task_id)
    references public.tasks(owner_id, project_id, id) on delete cascade
);

create index task_handoffs_task_created
  on public.task_handoffs(owner_id, project_id, task_id, created_at desc, id);

create table public.task_resources (
  owner_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  id uuid not null,
  introduced_by_handoff_id uuid,
  kind text not null check (kind in ('storage_object', 'external_url')),
  resource_type text not null default 'reference'
    check (resource_type in ('reference', 'document', 'image', 'artifact', 'repository', 'pull_request')),
  label text not null check (length(btrim(label)) between 1 and 200),
  external_url text,
  external_provider text,
  object_key text,
  original_filename text,
  media_type text,
  expected_bytes bigint,
  checksum_sha256 text,
  upload_status text not null check (upload_status in ('pending', 'uploaded', 'verified', 'failed', 'deleted')),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 500),
  created_by text not null,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  primary key (owner_id, id),
  unique (owner_id, project_id, task_id, id),
  foreign key (owner_id, project_id, task_id)
    references public.tasks(owner_id, project_id, id) on delete cascade,
  foreign key (owner_id, project_id, task_id, introduced_by_handoff_id)
    references public.task_handoffs(owner_id, project_id, task_id, id),
  check (
    (kind = 'external_url'
      and external_url ~ '^https://[^[:space:]]+$'
      and object_key is null and original_filename is null
      and expected_bytes is null and checksum_sha256 is null
      and upload_status = 'verified')
    or
    (kind = 'storage_object'
      and external_url is null and external_provider is null
      and object_key is not null and original_filename is not null
      and expected_bytes between 0 and 6291456
      and checksum_sha256 ~ '^[0-9a-f]{64}$')
  )
);

create index task_resources_task_created
  on public.task_resources(owner_id, project_id, task_id, created_at, id);
create unique index task_resources_object_key
  on public.task_resources(object_key) where object_key is not null;
create index task_resources_pending
  on public.task_resources(created_at)
  where kind = 'storage_object' and upload_status in ('pending', 'uploaded');

create table public.handoff_resource_refs (
  owner_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  handoff_id uuid not null,
  resource_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, handoff_id, resource_id),
  foreign key (owner_id, project_id, task_id, handoff_id)
    references public.task_handoffs(owner_id, project_id, task_id, id) on delete cascade,
  foreign key (owner_id, project_id, task_id, resource_id)
    references public.task_resources(owner_id, project_id, task_id, id) on delete cascade
);

create index handoff_resource_refs_resource
  on public.handoff_resource_refs(owner_id, project_id, task_id, resource_id);

create table public.task_events (
  owner_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  id bigint generated always as identity,
  event_type text not null check (event_type in (
    'created', 'content_updated', 'state_changed', 'handoff_recorded',
    'resource_added', 'resource_upload_reserved', 'resource_upload_verified',
    'resource_upload_failed', 'resource_upload_deleted'
  )),
  from_revision bigint,
  to_revision bigint not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  foreign key (owner_id, project_id, task_id)
    references public.tasks(owner_id, project_id, id) on delete cascade,
  check (from_revision is null or to_revision > from_revision)
);

create index task_events_task_created
  on public.task_events(owner_id, project_id, task_id, created_at, id);

create table public.task_write_requests (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  operation text not null check (operation in (
    'create_task', 'update_task', 'transition_task', 'record_task_handoff',
    'add_task_resource', 'reserve_task_file', 'finalize_task_file', 'fail_task_file'
  )),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{32}$'),
  task_id uuid not null,
  handoff_id uuid,
  resource_id uuid,
  result_revision bigint not null,
  completed_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);

alter table public.tasks enable row level security;
alter table public.task_handoffs enable row level security;
alter table public.task_resources enable row level security;
alter table public.handoff_resource_refs enable row level security;
alter table public.task_events enable row level security;
alter table public.task_write_requests enable row level security;

revoke all on public.tasks, public.task_handoffs, public.task_resources,
  public.handoff_resource_refs, public.task_events, public.task_write_requests
  from public, anon, authenticated;
grant select on public.tasks, public.task_handoffs, public.task_resources,
  public.handoff_resource_refs, public.task_events to authenticated;

create policy companion_task_read on public.tasks
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy agent_task_read on public.tasks
  for select to authenticated
  using (owner_id = (select auth.uid()) and private.agent_can_access_tasks(project_id, 'read'));

create policy companion_handoff_read on public.task_handoffs
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy agent_handoff_read on public.task_handoffs
  for select to authenticated
  using (owner_id = (select auth.uid()) and private.agent_can_access_tasks(project_id, 'read'));

create policy companion_resource_read on public.task_resources
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy agent_resource_read on public.task_resources
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and upload_status = 'verified'
    and private.agent_can_access_tasks(project_id, 'read')
  );

create policy companion_handoff_resource_read on public.handoff_resource_refs
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy agent_handoff_resource_read on public.handoff_resource_refs
  for select to authenticated
  using (owner_id = (select auth.uid()) and private.agent_can_access_tasks(project_id, 'read'));

create policy companion_task_event_read on public.task_events
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy agent_task_event_read on public.task_events
  for select to authenticated
  using (owner_id = (select auth.uid()) and private.agent_can_access_tasks(project_id, 'read'));

create policy agent_task_project_read on public.projects
  for select to authenticated
  using (owner_id = (select auth.uid()) and private.agent_can_access_tasks(id, 'read'));

create function public.authorize_agent_v2(
  p_client_id text,
  p_label text,
  p_personal boolean,
  p_project_ids uuid[],
  p_can_write boolean,
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
  if not p_personal and cardinality(p_project_ids) = 0 and cardinality(p_task_project_ids) = 0 then
    raise exception 'Select a memory or task scope' using errcode = '23514';
  end if;

  insert into public.agent_connections(
    owner_id, client_id, label, personal, project_ids, can_write,
    task_can_write, task_can_upload, grant_id
  ) values (
    auth.uid(), p_client_id, btrim(p_label), p_personal, p_project_ids, p_can_write,
    p_task_can_write, p_task_can_upload, next_grant
  )
  on conflict(owner_id, client_id) do update set
    label = excluded.label,
    personal = excluded.personal,
    project_ids = excluded.project_ids,
    can_write = excluded.can_write,
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

-- A legacy memory-only consent intentionally clears every task capability so
-- it cannot leave stale task permissions or misleading connection metadata.
create or replace function public.authorize_agent(
  p_client_id text,
  p_label text,
  p_personal boolean,
  p_project_ids uuid[],
  p_can_write boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare next_grant uuid := gen_random_uuid();
begin
  if auth.uid() is null or auth.jwt()->>'client_id' is not null then
    raise exception 'Companion sign-in required' using errcode = '42501';
  end if;
  if p_project_ids is null or cardinality(p_project_ids) > 100
    or array_position(p_project_ids, null) is not null
    or exists (select 1 from unnest(p_project_ids) p where not exists
      (select 1 from public.projects where id = p and owner_id = auth.uid())) then
    raise exception 'Invalid project selection' using errcode = '42501';
  end if;
  if not p_personal and cardinality(p_project_ids) = 0 then
    raise exception 'Select a memory scope' using errcode = '23514';
  end if;
  insert into public.agent_connections(
    owner_id, client_id, label, personal, project_ids, can_write,
    task_can_write, task_can_upload, grant_id
  ) values (
    auth.uid(), p_client_id, btrim(p_label), p_personal, p_project_ids, p_can_write,
    false, false, next_grant
  )
  on conflict(owner_id, client_id) do update set
    label = excluded.label, personal = excluded.personal,
    project_ids = excluded.project_ids, can_write = excluded.can_write,
    task_can_write = false, task_can_upload = false,
    revoked_at = null, grant_id = excluded.grant_id;
  delete from public.agent_task_grants
    where owner_id = auth.uid() and client_id = p_client_id;
end;
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
      task_can_write = false, task_can_upload = false
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

create function public.create_task(
  p_request_id uuid,
  p_id uuid,
  p_project_id uuid,
  p_title text,
  p_outcome text default '',
  p_why text default '',
  p_done_when text[] default '{}',
  p_next_action text default '',
  p_priority text default 'medium'
) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare
  result public.tasks;
  previous public.task_write_requests;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'project_id', p_project_id, 'title', btrim(p_title),
    'outcome', p_outcome, 'why', p_why, 'done_when', p_done_when,
    'next_action', p_next_action, 'priority', p_priority
  )::text);
begin
  if not private.task_can_access(p_project_id, 'write') then
    raise exception 'Task write unavailable' using errcode = '42501';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'create_task' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into result from public.tasks
      where owner_id = auth.uid() and id = previous.task_id;
    return result;
  end if;

  insert into public.tasks(
    owner_id, project_id, id, title, outcome, why, done_when,
    next_action, priority, created_by, updated_by
  ) values (
    auth.uid(), p_project_id, p_id, btrim(p_title), p_outcome, p_why,
    p_done_when, p_next_action, p_priority, actor, actor
  ) returning * into result;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, to_revision, details, created_by
  ) values (
    auth.uid(), p_project_id, p_id, 'created', result.revision,
    jsonb_build_object('status', result.status, 'priority', result.priority), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, result_revision
  ) values (auth.uid(), p_request_id, 'create_task', payload_hash, p_id, result.revision);
  return result;
exception when unique_violation then
  raise exception 'Task request conflict' using errcode = 'PT409';
end;
$$;

create function public.update_task(
  p_request_id uuid,
  p_id uuid,
  p_expected_revision bigint,
  p_title text,
  p_outcome text,
  p_why text,
  p_done_when text[],
  p_next_action text,
  p_priority text
) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare
  result public.tasks;
  previous public.task_write_requests;
  current_project uuid;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'expected_revision', p_expected_revision, 'title', btrim(p_title),
    'outcome', p_outcome, 'why', p_why, 'done_when', p_done_when,
    'next_action', p_next_action, 'priority', p_priority
  )::text);
begin
  select project_id into current_project from public.tasks
    where owner_id = auth.uid() and id = p_id;
  if current_project is null or not private.task_can_access(current_project, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'update_task' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    return result;
  end if;

  update public.tasks set
    title = btrim(p_title), outcome = p_outcome, why = p_why,
    done_when = p_done_when, next_action = p_next_action, priority = p_priority,
    revision = revision + 1, updated_by = actor, updated_at = clock_timestamp()
  where owner_id = auth.uid() and id = p_id and revision = p_expected_revision
  returning * into result;
  if result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409';
  end if;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), result.project_id, result.id, 'content_updated',
    p_expected_revision, result.revision,
    jsonb_build_object('priority', result.priority), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, result_revision
  ) values (auth.uid(), p_request_id, 'update_task', payload_hash, p_id, result.revision);
  return result;
end;
$$;

create function public.transition_task(
  p_request_id uuid,
  p_id uuid,
  p_expected_revision bigint,
  p_status text,
  p_blocked_reason text default ''
) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare
  result public.tasks;
  previous public.task_write_requests;
  current_project uuid;
  old_status text;
  actor text := private.task_actor();
  normalized_reason text := case when p_status = 'blocked' then btrim(p_blocked_reason) else '' end;
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'expected_revision', p_expected_revision,
    'status', p_status, 'blocked_reason', normalized_reason
  )::text);
begin
  select project_id, status into current_project, old_status from public.tasks
    where owner_id = auth.uid() and id = p_id;
  if current_project is null or not private.task_can_access(current_project, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'transition_task' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    return result;
  end if;

  update public.tasks set
    status = p_status,
    blocked_reason = normalized_reason,
    closed_at = case when p_status = 'done' then clock_timestamp() else null end,
    revision = revision + 1,
    updated_by = actor,
    updated_at = clock_timestamp()
  where owner_id = auth.uid() and id = p_id and revision = p_expected_revision
  returning * into result;
  if result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409';
  end if;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), result.project_id, result.id, 'state_changed',
    p_expected_revision, result.revision,
    jsonb_build_object('from', old_status, 'to', result.status, 'blocked_reason', result.blocked_reason), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, result_revision
  ) values (auth.uid(), p_request_id, 'transition_task', payload_hash, p_id, result.revision);
  return result;
end;
$$;

create function public.record_task_handoff(
  p_request_id uuid,
  p_id uuid,
  p_task_id uuid,
  p_expected_revision bigint,
  p_supersedes_ids uuid[],
  p_completed text[],
  p_decisions text[],
  p_validation jsonb,
  p_remaining text[],
  p_blockers text[],
  p_next_action text,
  p_summary text default '',
  p_status text default null,
  p_blocked_reason text default '',
  p_resource_ids uuid[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  task_result public.tasks;
  handoff_result public.task_handoffs;
  previous public.task_write_requests;
  current_project uuid;
  old_status text;
  old_reason text;
  actor text := private.task_actor();
  next_status text;
  next_reason text;
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'supersedes_ids', p_supersedes_ids, 'completed', p_completed, 'decisions', p_decisions,
    'validation', p_validation, 'remaining', p_remaining, 'blockers', p_blockers,
    'next_action', p_next_action, 'summary', p_summary, 'status', p_status,
    'blocked_reason', p_blocked_reason, 'resource_ids', p_resource_ids
  )::text);
begin
  select project_id, status, blocked_reason into current_project, old_status, old_reason from public.tasks
    where owner_id = auth.uid() and id = p_task_id;
  if current_project is null or not private.task_can_access(current_project, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'record_task_handoff' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into task_result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    select * into handoff_result from public.task_handoffs where owner_id = auth.uid() and id = previous.handoff_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'handoff', to_jsonb(handoff_result));
  end if;
  if array_position(p_supersedes_ids, p_id) is not null
    or (select count(*) from unnest(p_supersedes_ids) value)
      <> (select count(distinct value) from unnest(p_supersedes_ids) value)
    or exists (
      select 1 from unnest(p_supersedes_ids) value
      where not exists (
        select 1 from public.task_handoffs h
        where h.owner_id = auth.uid() and h.project_id = current_project
          and h.task_id = p_task_id and h.id = value
      )
    ) then
    raise exception 'Invalid handoff supersession' using errcode = '23514';
  end if;
  if array_position(p_resource_ids, null) is not null
    or exists (
      select 1 from unnest(p_resource_ids) value
      where not exists (
        select 1 from public.task_resources r
        where r.owner_id = auth.uid() and r.project_id = current_project
          and r.task_id = p_task_id and r.id = value and r.upload_status = 'verified'
      )
    ) then
    raise exception 'Invalid handoff resource' using errcode = '23514';
  end if;

  next_status := coalesce(p_status, old_status);
  next_reason := case
    when next_status <> 'blocked' then ''
    when p_status is null then old_reason
    else btrim(p_blocked_reason)
  end;
  update public.tasks set
    next_action = p_next_action,
    status = next_status,
    blocked_reason = next_reason,
    closed_at = case when next_status = 'done' then clock_timestamp() else null end,
    revision = revision + 1,
    updated_by = actor,
    updated_at = clock_timestamp()
  where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
  returning * into task_result;
  if task_result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409';
  end if;

  insert into public.task_handoffs(
    owner_id, project_id, task_id, id, supersedes_ids, completed, decisions,
    validation, remaining, blockers, next_action, summary, created_by
  ) values (
    auth.uid(), current_project, p_task_id, p_id, p_supersedes_ids, p_completed,
    p_decisions, p_validation, p_remaining, p_blockers, p_next_action, p_summary, actor
  ) returning * into handoff_result;
  insert into public.handoff_resource_refs(owner_id, project_id, task_id, handoff_id, resource_id)
    select auth.uid(), current_project, p_task_id, p_id, value
    from (select distinct unnest(p_resource_ids) value) selected;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_project, p_task_id, 'handoff_recorded',
    p_expected_revision, task_result.revision,
    jsonb_build_object('handoff_id', p_id, 'status_from', old_status, 'status_to', next_status), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, handoff_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'record_task_handoff', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'handoff', to_jsonb(handoff_result));
end;
$$;

create function public.add_task_resource(
  p_request_id uuid,
  p_id uuid,
  p_task_id uuid,
  p_expected_revision bigint,
  p_label text,
  p_url text,
  p_resource_type text default 'reference',
  p_provider text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  task_result public.tasks;
  resource_result public.task_resources;
  previous public.task_write_requests;
  current_project uuid;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'label', btrim(p_label), 'url', p_url, 'resource_type', p_resource_type,
    'provider', p_provider
  )::text);
begin
  select project_id into current_project from public.tasks
    where owner_id = auth.uid() and id = p_task_id;
  if current_project is null or not private.task_can_access(current_project, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'add_task_resource' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into task_result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    select * into resource_result from public.task_resources where owner_id = auth.uid() and id = previous.resource_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'resource', to_jsonb(resource_result));
  end if;

  update public.tasks set revision = revision + 1, updated_by = actor, updated_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    returning * into task_result;
  if task_result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409';
  end if;
  insert into public.task_resources(
    owner_id, project_id, task_id, id, kind, resource_type, label,
    external_url, external_provider, upload_status, created_by, verified_at
  ) values (
    auth.uid(), current_project, p_task_id, p_id, 'external_url', p_resource_type,
    btrim(p_label), p_url, nullif(btrim(p_provider), ''), 'verified', actor, now()
  ) returning * into resource_result;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_project, p_task_id, 'resource_added',
    p_expected_revision, task_result.revision,
    jsonb_build_object('resource_id', p_id, 'kind', 'external_url'), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'add_task_resource', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'resource', to_jsonb(resource_result));
end;
$$;

create function public.reserve_task_file(
  p_request_id uuid,
  p_id uuid,
  p_task_id uuid,
  p_expected_revision bigint,
  p_label text,
  p_original_filename text,
  p_media_type text,
  p_expected_bytes bigint,
  p_checksum_sha256 text,
  p_resource_type text default 'document'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  task_result public.tasks;
  resource_result public.task_resources;
  previous public.task_write_requests;
  current_project uuid;
  actor text := private.task_actor();
  object_key text := auth.uid()::text || '/' || p_task_id::text || '/' || p_id::text;
  normalized_checksum text := lower(p_checksum_sha256);
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'label', btrim(p_label), 'original_filename', p_original_filename,
    'media_type', p_media_type, 'expected_bytes', p_expected_bytes,
    'checksum_sha256', normalized_checksum, 'resource_type', p_resource_type
  )::text);
begin
  select project_id into current_project from public.tasks
    where owner_id = auth.uid() and id = p_task_id;
  if current_project is null or not private.task_can_access(current_project, 'upload') then
    raise exception 'Task upload unavailable' using errcode = '42501';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'reserve_task_file' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into task_result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    select * into resource_result from public.task_resources where owner_id = auth.uid() and id = previous.resource_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'resource', to_jsonb(resource_result));
  end if;

  update public.tasks set revision = revision + 1, updated_by = actor, updated_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    returning * into task_result;
  if task_result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409';
  end if;
  insert into public.task_resources(
    owner_id, project_id, task_id, id, kind, resource_type, label, object_key,
    original_filename, media_type, expected_bytes, checksum_sha256,
    upload_status, created_by
  ) values (
    auth.uid(), current_project, p_task_id, p_id, 'storage_object', p_resource_type,
    btrim(p_label), object_key, p_original_filename, p_media_type, p_expected_bytes,
    normalized_checksum, 'pending', actor
  ) returning * into resource_result;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_project, p_task_id, 'resource_upload_reserved',
    p_expected_revision, task_result.revision,
    jsonb_build_object('resource_id', p_id, 'expected_bytes', p_expected_bytes), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'reserve_task_file', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'resource', to_jsonb(resource_result));
end;
$$;

create function private.can_upload_task_object(p_object_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.task_resources r
    where r.owner_id = (select auth.uid())
      and r.object_key = p_object_key
      and r.kind = 'storage_object'
      and r.upload_status = 'pending'
      and private.task_can_access(r.project_id, 'upload')
  );
$$;

create function private.can_read_task_object(p_object_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.task_resources r
    where r.owner_id = (select auth.uid())
      and r.object_key = p_object_key
      and r.kind = 'storage_object'
      and r.upload_status = 'verified'
      and private.task_can_access(r.project_id, 'read')
  );
$$;

revoke execute on function private.can_upload_task_object(text),
  private.can_read_task_object(text) from public, anon, authenticated;
grant execute on function private.can_upload_task_object(text),
  private.can_read_task_object(text) to authenticated;

create function public.finalize_task_file(
  p_request_id uuid,
  p_resource_id uuid
) returns public.task_resources
language plpgsql security definer set search_path = '' as $$
declare
  resource_result public.task_resources;
  previous public.task_write_requests;
  actual_bytes bigint;
  actual_checksum text;
  payload_hash text := md5(jsonb_build_object('resource_id', p_resource_id)::text);
begin
  select * into resource_result from public.task_resources
    where owner_id = auth.uid() and id = p_resource_id;
  if resource_result.id is null
    or not private.task_can_access(resource_result.project_id, 'upload') then
    raise exception 'Task upload unavailable' using errcode = '42501';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'finalize_task_file' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    return resource_result;
  end if;
  if resource_result.kind <> 'storage_object' or resource_result.upload_status <> 'pending' then
    raise exception 'Upload is not pending' using errcode = 'PT409';
  end if;

  execute $query$
    select coalesce((metadata->>'size')::bigint, 0), lower(user_metadata->>'sha256')
    from storage.objects
    where bucket_id = 'task-files' and name = $1
  $query$ into actual_bytes, actual_checksum using resource_result.object_key;
  if actual_bytes is distinct from resource_result.expected_bytes
    or actual_checksum is distinct from resource_result.checksum_sha256 then
    update public.task_resources set
      upload_status = 'failed', failure_reason = 'size_or_checksum_mismatch'
      where owner_id = auth.uid() and id = p_resource_id
      returning * into resource_result;
    insert into public.task_events(
      owner_id, project_id, task_id, event_type, to_revision, details, created_by
    ) values (
      resource_result.owner_id, resource_result.project_id, resource_result.task_id,
      'resource_upload_failed',
      (select revision from public.tasks where owner_id = resource_result.owner_id and id = resource_result.task_id),
      jsonb_build_object('resource_id', p_resource_id, 'reason', resource_result.failure_reason),
      private.task_actor()
    );
    insert into public.task_write_requests(
      owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
    ) values (
      auth.uid(), p_request_id, 'finalize_task_file', payload_hash,
      resource_result.task_id, resource_result.id,
      (select revision from public.tasks where owner_id = auth.uid() and id = resource_result.task_id)
    );
    return resource_result;
  end if;
  update public.task_resources set
    upload_status = 'verified', verified_at = clock_timestamp(), failure_reason = null
    where owner_id = auth.uid() and id = p_resource_id
    returning * into resource_result;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, to_revision, details, created_by
  ) values (
    resource_result.owner_id, resource_result.project_id, resource_result.task_id,
    'resource_upload_verified',
    (select revision from public.tasks where owner_id = resource_result.owner_id and id = resource_result.task_id),
    jsonb_build_object('resource_id', p_resource_id, 'bytes', actual_bytes),
    private.task_actor()
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'finalize_task_file', payload_hash,
    resource_result.task_id, resource_result.id,
    (select revision from public.tasks where owner_id = auth.uid() and id = resource_result.task_id)
  );
  return resource_result;
end;
$$;

create function public.fail_task_file(
  p_request_id uuid,
  p_resource_id uuid,
  p_reason text
) returns public.task_resources
language plpgsql security definer set search_path = '' as $$
declare
  resource_result public.task_resources;
  previous public.task_write_requests;
  payload_hash text := md5(jsonb_build_object(
    'resource_id', p_resource_id, 'reason', left(btrim(p_reason), 500)
  )::text);
begin
  select * into resource_result from public.task_resources
    where owner_id = auth.uid() and id = p_resource_id;
  if resource_result.id is null
    or not private.task_can_access(resource_result.project_id, 'upload') then
    raise exception 'Task upload unavailable' using errcode = '42501';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'fail_task_file' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    return resource_result;
  end if;
  if resource_result.kind <> 'storage_object' or resource_result.upload_status <> 'pending' then
    raise exception 'Upload is not pending' using errcode = 'PT409';
  end if;
  update public.task_resources set upload_status = 'failed', failure_reason = left(btrim(p_reason), 500)
    where owner_id = auth.uid() and id = p_resource_id
    returning * into resource_result;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, to_revision, details, created_by
  ) values (
    resource_result.owner_id, resource_result.project_id, resource_result.task_id,
    'resource_upload_failed',
    (select revision from public.tasks where owner_id = resource_result.owner_id and id = resource_result.task_id),
    jsonb_build_object('resource_id', p_resource_id, 'reason', resource_result.failure_reason),
    private.task_actor()
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'fail_task_file', payload_hash,
    resource_result.task_id, resource_result.id,
    (select revision from public.tasks where owner_id = auth.uid() and id = resource_result.task_id)
  );
  return resource_result;
end;
$$;

-- The trusted cleanup worker removes the object through the Storage API first,
-- then calls this function so metadata and its event change atomically.
create function public.cleanup_task_file(
  p_owner_id uuid,
  p_resource_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  resource_result public.task_resources;
  task_revision bigint;
begin
  select * into resource_result from public.task_resources
    where owner_id = p_owner_id and id = p_resource_id
      and kind = 'storage_object'
      and upload_status in ('pending', 'failed')
      and created_at < now() - interval '24 hours'
    for update;
  if resource_result.id is null then return; end if;
  select revision into task_revision from public.tasks
    where owner_id = resource_result.owner_id and id = resource_result.task_id;
  update public.task_resources set
    upload_status = 'deleted', failure_reason = 'abandoned_upload_cleanup'
    where owner_id = resource_result.owner_id and id = resource_result.id;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, to_revision, details, created_by
  ) values (
    resource_result.owner_id, resource_result.project_id, resource_result.task_id,
    'resource_upload_deleted', task_revision,
    jsonb_build_object('resource_id', resource_result.id, 'reason', 'abandoned_upload_cleanup'),
    'system:upload-cleanup'
  );
end;
$$;

create function public.export_tasks(p_project_id uuid default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'version', 1,
    'exported_at', now(),
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.created_at, t.id)
      from public.tasks t
      where p_project_id is null or t.project_id = p_project_id
    ), '[]'::jsonb),
    'handoffs', coalesce((
      select jsonb_agg(to_jsonb(h) order by h.created_at, h.id)
      from public.task_handoffs h
      where p_project_id is null or h.project_id = p_project_id
    ), '[]'::jsonb),
    'resources', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id)
      from public.task_resources r
      where p_project_id is null or r.project_id = p_project_id
    ), '[]'::jsonb),
    'handoff_resource_refs', coalesce((
      select jsonb_agg(to_jsonb(ref) order by ref.created_at)
      from public.handoff_resource_refs ref
      where p_project_id is null or ref.project_id = p_project_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
      from public.task_events e
      where p_project_id is null or e.project_id = p_project_id
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.authorize_agent_v2(text,text,boolean,uuid[],boolean,uuid[],boolean,boolean),
  public.create_task(uuid,uuid,uuid,text,text,text,text[],text,text),
  public.update_task(uuid,uuid,bigint,text,text,text,text[],text,text),
  public.transition_task(uuid,uuid,bigint,text,text),
  public.record_task_handoff(uuid,uuid,uuid,bigint,uuid[],text[],text[],jsonb,text[],text[],text,text,text,text,uuid[]),
  public.add_task_resource(uuid,uuid,uuid,bigint,text,text,text,text),
  public.reserve_task_file(uuid,uuid,uuid,bigint,text,text,text,bigint,text,text),
  public.finalize_task_file(uuid,uuid),
  public.fail_task_file(uuid,uuid,text),
  public.cleanup_task_file(uuid,uuid),
  public.export_tasks(uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_agent_v2(text,text,boolean,uuid[],boolean,uuid[],boolean,boolean),
  public.create_task(uuid,uuid,uuid,text,text,text,text[],text,text),
  public.update_task(uuid,uuid,bigint,text,text,text,text[],text,text),
  public.transition_task(uuid,uuid,bigint,text,text),
  public.record_task_handoff(uuid,uuid,uuid,bigint,uuid[],text[],text[],jsonb,text[],text[],text,text,text,text,uuid[]),
  public.add_task_resource(uuid,uuid,uuid,bigint,text,text,text,text),
  public.reserve_task_file(uuid,uuid,uuid,bigint,text,text,text,bigint,text,text),
  public.finalize_task_file(uuid,uuid),
  public.fail_task_file(uuid,uuid,text),
  public.export_tasks(uuid)
  to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.cleanup_task_file(uuid,uuid) to service_role;
  end if;
end;
$$;

-- Storage is provisioned through the Storage API as a private `task-files`
-- bucket. Policies are installed only when the hosted Storage schema exists;
-- the local PGlite contract tests intentionally do not emulate its API.
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute $policy$
      create policy task_file_upload on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'task-files'
        and private.can_upload_task_object(name)
      )
    $policy$;
    execute $policy$
      create policy task_file_download on storage.objects
      for select to authenticated
      using (
        bucket_id = 'task-files'
        and private.can_read_task_object(name)
      )
    $policy$;
  end if;
end;
$$;

commit;
