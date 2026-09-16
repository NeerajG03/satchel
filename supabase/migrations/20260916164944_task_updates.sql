begin;

-- Comments are lightweight conversation. Progress updates are structured,
-- append-only work snapshots that can atomically advance the canonical task.
-- Both share one timeline table so clients can render them chronologically.
alter table public.tasks
  add column last_activity_at timestamptz;
update public.tasks set last_activity_at = updated_at where last_activity_at is null;
alter table public.tasks
  alter column last_activity_at set default now(),
  alter column last_activity_at set not null;

create index tasks_scope_activity
  on public.tasks(owner_id, scope_key, last_activity_at desc, id);

create table public.task_updates (
  owner_id uuid not null,
  project_id uuid,
  scope_key text generated always as (coalesce(project_id::text, 'personal')) stored,
  task_id uuid not null,
  id uuid not null,
  kind text not null check (kind in ('comment', 'progress')),
  body text not null check (length(btrim(body)) between 1 and 4000),
  completed text[] not null default '{}' check (
    cardinality(completed) <= 50 and array_position(completed, null) is null
  ),
  decisions text[] not null default '{}' check (
    cardinality(decisions) <= 50 and array_position(decisions, null) is null
  ),
  remaining text[] not null default '{}' check (
    cardinality(remaining) <= 50 and array_position(remaining, null) is null
  ),
  blockers text[] not null default '{}' check (
    cardinality(blockers) <= 50 and array_position(blockers, null) is null
  ),
  next_action text check (next_action is null or length(next_action) <= 1000),
  status text check (status is null or status in ('inbox', 'ready', 'in_progress', 'blocked', 'done')),
  blocked_reason text not null default '' check (
    length(blocked_reason) <= 2000
    and ((status = 'blocked' and length(btrim(blocked_reason)) > 0)
      or (status is distinct from 'blocked' and blocked_reason = ''))
  ),
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, scope_key, task_id, id),
  foreign key (owner_id, scope_key, task_id)
    references public.tasks(owner_id, scope_key, id) on delete cascade,
  check (
    (kind = 'comment' and cardinality(completed) = 0 and cardinality(decisions) = 0
      and cardinality(remaining) = 0 and cardinality(blockers) = 0
      and next_action is null and status is null and blocked_reason = '')
    or
    (kind = 'progress' and next_action is not null and status is not null)
  ),
  check (length(array_to_string(completed, '')) <= 20000),
  check (length(array_to_string(decisions, '')) <= 20000),
  check (length(array_to_string(remaining, '')) <= 20000),
  check (length(array_to_string(blockers, '')) <= 20000)
);

create index task_updates_task_created
  on public.task_updates(owner_id, scope_key, task_id, created_at desc, id);

create table public.task_update_resource_refs (
  owner_id uuid not null,
  project_id uuid,
  scope_key text generated always as (coalesce(project_id::text, 'personal')) stored,
  task_id uuid not null,
  update_id uuid not null,
  resource_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, update_id, resource_id),
  foreign key (owner_id, scope_key, task_id, update_id)
    references public.task_updates(owner_id, scope_key, task_id, id) on delete cascade,
  foreign key (owner_id, scope_key, task_id, resource_id)
    references public.task_resources(owner_id, scope_key, task_id, id) on delete cascade
);

create index task_update_resource_refs_resource
  on public.task_update_resource_refs(owner_id, scope_key, task_id, resource_id);

alter table public.task_events
  drop constraint task_events_event_type_check,
  add constraint task_events_event_type_check check (event_type in (
    'created', 'content_updated', 'state_changed', 'handoff_recorded',
    'comment_added', 'progress_recorded',
    'resource_added', 'resource_upload_reserved', 'resource_upload_verified',
    'resource_upload_failed', 'resource_upload_deleted'
  ));

alter table public.task_write_requests
  drop constraint task_write_requests_operation_check,
  add column update_id uuid,
  add constraint task_write_requests_operation_check check (operation in (
    'create_task', 'update_task', 'transition_task', 'record_task_handoff',
    'add_task_comment', 'record_task_progress',
    'add_task_resource', 'reserve_task_file', 'finalize_task_file', 'fail_task_file'
  ));

alter table public.task_updates enable row level security;
alter table public.task_update_resource_refs enable row level security;

revoke all on public.task_updates, public.task_update_resource_refs
  from public, anon, authenticated;
grant select on public.task_updates, public.task_update_resource_refs to authenticated;

create policy companion_task_update_read on public.task_updates
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy agent_task_update_read on public.task_updates
  for select to authenticated
  using (owner_id = (select auth.uid()) and private.agent_can_access_tasks(project_id, 'read'));

create policy companion_task_update_resource_read on public.task_update_resource_refs
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy agent_task_update_resource_read on public.task_update_resource_refs
  for select to authenticated
  using (owner_id = (select auth.uid()) and private.agent_can_access_tasks(project_id, 'read'));

-- Every task event advances list recency without changing the optimistic
-- concurrency revision. Comments therefore do not invalidate an in-flight
-- content edit, while still surfacing the task as recently active.
create function private.touch_task_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.tasks
    set last_activity_at = greatest(last_activity_at, new.created_at)
    where owner_id = new.owner_id and id = new.task_id;
  return new;
end;
$$;

revoke execute on function private.touch_task_activity() from public, anon, authenticated;

create trigger task_event_touch_activity
after insert on public.task_events
for each row execute function private.touch_task_activity();

create function public.add_task_comment(
  p_request_id uuid,
  p_id uuid,
  p_task_id uuid,
  p_body text,
  p_resource_ids uuid[] default '{}'
) returns public.task_updates
language plpgsql security definer set search_path = '' as $$
declare
  task_result public.tasks;
  update_result public.task_updates;
  previous public.task_write_requests;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'body', p_body,
    'resource_ids', p_resource_ids
  )::text);
begin
  select * into task_result from public.tasks
    where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(task_result.project_id, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;

  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'add_task_comment' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into update_result from public.task_updates
      where owner_id = auth.uid() and id = previous.update_id;
    return update_result;
  end if;

  if p_resource_ids is null or array_position(p_resource_ids, null) is not null
    or (select count(*) from unnest(p_resource_ids) value)
      <> (select count(distinct value) from unnest(p_resource_ids) value)
    or exists (
      select 1 from unnest(p_resource_ids) value
      where not exists (
        select 1 from public.task_resources r
        where r.owner_id = auth.uid()
          and r.project_id is not distinct from task_result.project_id
          and r.task_id = p_task_id and r.id = value and r.upload_status = 'verified'
      )
    ) then
    raise exception 'Invalid comment resource' using errcode = '23514';
  end if;

  insert into public.task_updates(
    owner_id, project_id, task_id, id, kind, body, created_by
  ) values (
    auth.uid(), task_result.project_id, p_task_id, p_id, 'comment', btrim(p_body), actor
  ) returning * into update_result;

  insert into public.task_update_resource_refs(
    owner_id, project_id, task_id, update_id, resource_id
  ) select auth.uid(), task_result.project_id, p_task_id, p_id, value
    from unnest(p_resource_ids) value;

  insert into public.task_events(
    owner_id, project_id, task_id, event_type, to_revision, details, created_by
  ) values (
    auth.uid(), task_result.project_id, p_task_id, 'comment_added', task_result.revision,
    jsonb_build_object('update_id', p_id, 'resource_count', cardinality(p_resource_ids)), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, update_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'add_task_comment', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return update_result;
end;
$$;

create function public.record_task_progress(
  p_request_id uuid,
  p_id uuid,
  p_task_id uuid,
  p_expected_revision bigint,
  p_summary text,
  p_completed text[] default '{}',
  p_decisions text[] default '{}',
  p_remaining text[] default '{}',
  p_blockers text[] default '{}',
  p_next_action text default null,
  p_status text default null,
  p_blocked_reason text default '',
  p_resource_ids uuid[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  task_result public.tasks;
  update_result public.task_updates;
  previous public.task_write_requests;
  current_project uuid;
  old_status text;
  old_reason text;
  old_next_action text;
  actor text := private.task_actor();
  next_status text;
  next_reason text;
  resolved_next_action text;
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'summary', p_summary, 'completed', p_completed, 'decisions', p_decisions,
    'remaining', p_remaining, 'blockers', p_blockers, 'next_action', p_next_action,
    'status', p_status, 'blocked_reason', p_blocked_reason, 'resource_ids', p_resource_ids
  )::text);
begin
  select project_id, status, blocked_reason, next_action
    into current_project, old_status, old_reason, old_next_action
    from public.tasks where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_project, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;

  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'record_task_progress' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into task_result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    select * into update_result from public.task_updates where owner_id = auth.uid() and id = previous.update_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'update', to_jsonb(update_result));
  end if;

  if p_completed is null or p_decisions is null or p_remaining is null or p_blockers is null
    or p_resource_ids is null
    or array_position(p_resource_ids, null) is not null
    or (select count(*) from unnest(p_resource_ids) value)
      <> (select count(distinct value) from unnest(p_resource_ids) value)
    or exists (
      select 1 from unnest(p_resource_ids) value
      where not exists (
        select 1 from public.task_resources r
        where r.owner_id = auth.uid()
          and r.project_id is not distinct from current_project
          and r.task_id = p_task_id and r.id = value and r.upload_status = 'verified'
      )
    ) then
    raise exception 'Invalid progress update' using errcode = '23514';
  end if;

  next_status := coalesce(p_status, old_status);
  if next_status not in ('inbox', 'ready', 'in_progress', 'blocked', 'done') then
    raise exception 'Invalid task state' using errcode = '23514';
  end if;
  next_reason := case
    when next_status <> 'blocked' then ''
    when p_status is null then old_reason
    else btrim(p_blocked_reason)
  end;
  if next_status = 'blocked' and length(btrim(next_reason)) = 0 then
    raise exception 'Blocked tasks require a reason' using errcode = '23514';
  end if;
  resolved_next_action := coalesce(p_next_action, old_next_action);

  update public.tasks set
    next_action = resolved_next_action,
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

  insert into public.task_updates(
    owner_id, project_id, task_id, id, kind, body, completed, decisions,
    remaining, blockers, next_action, status, blocked_reason, created_by
  ) values (
    auth.uid(), current_project, p_task_id, p_id, 'progress', btrim(p_summary),
    p_completed, p_decisions, p_remaining, p_blockers,
    task_result.next_action, task_result.status, task_result.blocked_reason, actor
  ) returning * into update_result;

  insert into public.task_update_resource_refs(
    owner_id, project_id, task_id, update_id, resource_id
  ) select auth.uid(), current_project, p_task_id, p_id, value
    from unnest(p_resource_ids) value;

  insert into public.task_events(
    owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_project, p_task_id, 'progress_recorded',
    p_expected_revision, task_result.revision,
    jsonb_build_object(
      'update_id', p_id, 'status_from', old_status, 'status_to', next_status,
      'resource_count', cardinality(p_resource_ids)
    ), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, update_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'record_task_progress', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'update', to_jsonb(update_result));
end;
$$;

create or replace function public.export_tasks(p_project_id uuid default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'version', 2,
    'exported_at', now(),
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.created_at, t.id)
      from public.tasks t
      where t.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'handoffs', coalesce((
      select jsonb_agg(to_jsonb(h) order by h.created_at, h.id)
      from public.task_handoffs h
      where h.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'updates', coalesce((
      select jsonb_agg(to_jsonb(u) order by u.created_at, u.id)
      from public.task_updates u
      where u.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'resources', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id)
      from public.task_resources r
      where r.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'handoff_resource_refs', coalesce((
      select jsonb_agg(to_jsonb(ref) order by ref.created_at)
      from public.handoff_resource_refs ref
      where ref.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'update_resource_refs', coalesce((
      select jsonb_agg(to_jsonb(ref) order by ref.created_at)
      from public.task_update_resource_refs ref
      where ref.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
      from public.task_events e
      where e.project_id is not distinct from p_project_id
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.add_task_comment(uuid,uuid,uuid,text,uuid[]),
  public.record_task_progress(uuid,uuid,uuid,bigint,text,text[],text[],text[],text[],text,text,text,uuid[])
  from public, anon, authenticated;
grant execute on function public.add_task_comment(uuid,uuid,uuid,text,uuid[]),
  public.record_task_progress(uuid,uuid,uuid,bigint,text,text[],text[],text[],text[],text,text,text,uuid[])
  to authenticated;

commit;
