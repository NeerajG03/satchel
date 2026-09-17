begin;

-- A task has at most one structural parent, but may depend on many peers.
-- Both relationships are scope-bound in the database; application checks are
-- not trusted to preserve tenant, project, or personal-scope integrity.
create table public.task_parent_edges (
  owner_id uuid not null,
  project_id uuid,
  scope_key text generated always as (coalesce(project_id::text, 'personal')) stored,
  child_task_id uuid not null,
  parent_task_id uuid not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, child_task_id),
  foreign key (owner_id, scope_key, child_task_id)
    references public.tasks(owner_id, scope_key, id) on delete cascade,
  foreign key (owner_id, scope_key, parent_task_id)
    references public.tasks(owner_id, scope_key, id) on delete cascade,
  check (child_task_id <> parent_task_id)
);

create index task_parent_edges_parent
  on public.task_parent_edges(owner_id, scope_key, parent_task_id, child_task_id);

create table public.task_dependencies (
  owner_id uuid not null,
  project_id uuid,
  scope_key text generated always as (coalesce(project_id::text, 'personal')) stored,
  task_id uuid not null,
  depends_on_task_id uuid not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, task_id, depends_on_task_id),
  foreign key (owner_id, scope_key, task_id)
    references public.tasks(owner_id, scope_key, id) on delete cascade,
  foreign key (owner_id, scope_key, depends_on_task_id)
    references public.tasks(owner_id, scope_key, id) on delete cascade,
  check (task_id <> depends_on_task_id)
);

create index task_dependencies_prerequisite
  on public.task_dependencies(owner_id, scope_key, depends_on_task_id, task_id);

alter table public.task_parent_edges enable row level security;
alter table public.task_dependencies enable row level security;
revoke all on public.task_parent_edges, public.task_dependencies
  from public, anon, authenticated;
grant select on public.task_parent_edges, public.task_dependencies to authenticated;

create policy task_parent_edges_read on public.task_parent_edges
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and (
      (select auth.jwt())->>'client_id' is null
      or private.agent_can_access_tasks(project_id, 'read')
    )
  );

create policy task_dependencies_read on public.task_dependencies
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and (
      (select auth.jwt())->>'client_id' is null
      or private.agent_can_access_tasks(project_id, 'read')
    )
  );

alter table public.task_events
  drop constraint task_events_event_type_check,
  add constraint task_events_event_type_check check (event_type in (
    'created', 'content_updated', 'state_changed', 'handoff_recorded',
    'comment_added', 'progress_recorded', 'parent_changed',
    'dependency_added', 'dependency_removed',
    'resource_added', 'resource_upload_reserved', 'resource_upload_verified',
    'resource_upload_failed', 'resource_upload_deleted'
  ));

alter table public.task_write_requests
  drop constraint task_write_requests_operation_check,
  add column related_task_id uuid,
  add constraint task_write_requests_operation_check check (operation in (
    'create_task', 'update_task', 'transition_task', 'record_task_handoff',
    'add_task_comment', 'record_task_progress', 'set_task_parent',
    'add_task_dependency', 'remove_task_dependency',
    'add_task_resource', 'reserve_task_file', 'finalize_task_file', 'fail_task_file'
  ));

-- The view is security-invoker so the underlying task/relation RLS policies
-- remain authoritative for both companion and agent reads.
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

create function public.set_task_parent(
  p_request_id uuid,
  p_task_id uuid,
  p_expected_revision bigint,
  p_parent_task_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  task_result public.tasks;
  previous public.task_write_requests;
  current_project uuid;
  current_scope text;
  old_parent_id uuid;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'parent_task_id', p_parent_task_id
  )::text);
begin
  select project_id, scope_key into current_project, current_scope
    from public.tasks where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_project, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;

  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'set_task_parent' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into task_result from public.tasks
      where owner_id = auth.uid() and id = previous.task_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'parent_id', previous.related_task_id);
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text), hashtext(current_scope));
  select * into task_result from public.tasks
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    for update;
  if not found then
    raise exception 'Task changed or unavailable' using errcode = 'PT409';
  end if;

  if p_parent_task_id = p_task_id then
    raise exception 'A task cannot parent itself' using errcode = '23514';
  end if;
  if p_parent_task_id is not null and not exists (
    select 1 from public.tasks candidate
    where candidate.owner_id = auth.uid() and candidate.scope_key = current_scope
      and candidate.id = p_parent_task_id
  ) then
    raise exception 'Parent task unavailable in this scope' using errcode = '23514';
  end if;
  if p_parent_task_id is not null and exists (
    with recursive ancestors(id) as (
      select p_parent_task_id
      union all
      select edge.parent_task_id
      from public.task_parent_edges edge
      join ancestors on edge.child_task_id = ancestors.id
      where edge.owner_id = auth.uid() and edge.scope_key = current_scope
    )
    select 1 from ancestors where id = p_task_id
  ) then
    raise exception 'Task parent cycle' using errcode = '23514';
  end if;

  select parent_task_id into old_parent_id from public.task_parent_edges
    where owner_id = auth.uid() and child_task_id = p_task_id;
  if old_parent_id is not distinct from p_parent_task_id then
    insert into public.task_write_requests(
      owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
    ) values (
      auth.uid(), p_request_id, 'set_task_parent', payload_hash,
      p_task_id, p_parent_task_id, task_result.revision
    );
    return jsonb_build_object('task', to_jsonb(task_result), 'parent_id', p_parent_task_id);
  end if;

  delete from public.task_parent_edges
    where owner_id = auth.uid() and child_task_id = p_task_id;
  if p_parent_task_id is not null then
    insert into public.task_parent_edges(
      owner_id, project_id, child_task_id, parent_task_id, created_by
    ) values (auth.uid(), current_project, p_task_id, p_parent_task_id, actor);
  end if;

  update public.tasks set revision = revision + 1, updated_by = actor,
    updated_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_task_id
    returning * into task_result;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_project, p_task_id, 'parent_changed',
    p_expected_revision, task_result.revision,
    jsonb_build_object('from', old_parent_id, 'to', p_parent_task_id), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'set_task_parent', payload_hash,
    p_task_id, p_parent_task_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'parent_id', p_parent_task_id);
end;
$$;

create function public.add_task_dependency(
  p_request_id uuid,
  p_task_id uuid,
  p_expected_revision bigint,
  p_depends_on_task_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  task_result public.tasks;
  previous public.task_write_requests;
  current_project uuid;
  current_scope text;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'depends_on_task_id', p_depends_on_task_id
  )::text);
begin
  select project_id, scope_key into current_project, current_scope
    from public.tasks where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_project, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'add_task_dependency' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into task_result from public.tasks
      where owner_id = auth.uid() and id = previous.task_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'depends_on_task_id', previous.related_task_id);
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text), hashtext(current_scope));
  select * into task_result from public.tasks
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    for update;
  if not found then
    raise exception 'Task changed or unavailable' using errcode = 'PT409';
  end if;
  if p_depends_on_task_id = p_task_id or not exists (
    select 1 from public.tasks candidate
    where candidate.owner_id = auth.uid() and candidate.scope_key = current_scope
      and candidate.id = p_depends_on_task_id
  ) then
    raise exception 'Dependency task unavailable in this scope' using errcode = '23514';
  end if;
  if exists (
    with recursive prerequisites(id) as (
      select p_depends_on_task_id
      union
      select edge.depends_on_task_id
      from public.task_dependencies edge
      join prerequisites on edge.task_id = prerequisites.id
      where edge.owner_id = auth.uid() and edge.scope_key = current_scope
    )
    select 1 from prerequisites where id = p_task_id
  ) then
    raise exception 'Task dependency cycle' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.task_dependencies
    where owner_id = auth.uid() and task_id = p_task_id
      and depends_on_task_id = p_depends_on_task_id
  ) then
    insert into public.task_write_requests(
      owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
    ) values (
      auth.uid(), p_request_id, 'add_task_dependency', payload_hash,
      p_task_id, p_depends_on_task_id, task_result.revision
    );
    return jsonb_build_object('task', to_jsonb(task_result), 'depends_on_task_id', p_depends_on_task_id);
  end if;

  insert into public.task_dependencies(
    owner_id, project_id, task_id, depends_on_task_id, created_by
  ) values (auth.uid(), current_project, p_task_id, p_depends_on_task_id, actor);
  update public.tasks set revision = revision + 1, updated_by = actor,
    updated_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_task_id
    returning * into task_result;
  insert into public.task_events(
    owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_project, p_task_id, 'dependency_added',
    p_expected_revision, task_result.revision,
    jsonb_build_object('depends_on_task_id', p_depends_on_task_id), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'add_task_dependency', payload_hash,
    p_task_id, p_depends_on_task_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'depends_on_task_id', p_depends_on_task_id);
end;
$$;

create function public.remove_task_dependency(
  p_request_id uuid,
  p_task_id uuid,
  p_expected_revision bigint,
  p_depends_on_task_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  task_result public.tasks;
  previous public.task_write_requests;
  current_project uuid;
  current_scope text;
  removed_id uuid;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'depends_on_task_id', p_depends_on_task_id
  )::text);
begin
  select project_id, scope_key into current_project, current_scope
    from public.tasks where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_project, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'remove_task_dependency' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409';
    end if;
    select * into task_result from public.tasks
      where owner_id = auth.uid() and id = previous.task_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'removed_task_id', previous.related_task_id);
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text), hashtext(current_scope));
  select * into task_result from public.tasks
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    for update;
  if not found then
    raise exception 'Task changed or unavailable' using errcode = 'PT409';
  end if;

  delete from public.task_dependencies
    where owner_id = auth.uid() and task_id = p_task_id
      and depends_on_task_id = p_depends_on_task_id
    returning depends_on_task_id into removed_id;
  if removed_id is not null then
    update public.tasks set revision = revision + 1, updated_by = actor,
      updated_at = clock_timestamp()
      where owner_id = auth.uid() and id = p_task_id
      returning * into task_result;
    insert into public.task_events(
      owner_id, project_id, task_id, event_type, from_revision, to_revision, details, created_by
    ) values (
      auth.uid(), current_project, p_task_id, 'dependency_removed',
      p_expected_revision, task_result.revision,
      jsonb_build_object('depends_on_task_id', p_depends_on_task_id), actor
    );
  end if;
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'remove_task_dependency', payload_hash,
    p_task_id, p_depends_on_task_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'removed_task_id', p_depends_on_task_id);
end;
$$;

create or replace function public.export_tasks(p_project_id uuid default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'version', 3,
    'exported_at', now(),
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.created_at, t.id)
      from public.tasks t where t.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'parent_edges', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at, p.child_task_id)
      from public.task_parent_edges p where p.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'dependencies', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.created_at, d.task_id, d.depends_on_task_id)
      from public.task_dependencies d where d.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'handoffs', coalesce((
      select jsonb_agg(to_jsonb(h) order by h.created_at, h.id)
      from public.task_handoffs h where h.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'updates', coalesce((
      select jsonb_agg(to_jsonb(u) order by u.created_at, u.id)
      from public.task_updates u where u.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'resources', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id)
      from public.task_resources r where r.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'handoff_resource_refs', coalesce((
      select jsonb_agg(to_jsonb(ref) order by ref.created_at)
      from public.handoff_resource_refs ref where ref.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'update_resource_refs', coalesce((
      select jsonb_agg(to_jsonb(ref) order by ref.created_at)
      from public.task_update_resource_refs ref where ref.project_id is not distinct from p_project_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
      from public.task_events e where e.project_id is not distinct from p_project_id
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.set_task_parent(uuid,uuid,bigint,uuid),
  public.add_task_dependency(uuid,uuid,bigint,uuid),
  public.remove_task_dependency(uuid,uuid,bigint,uuid)
  from public, anon, authenticated;
grant execute on function public.set_task_parent(uuid,uuid,bigint,uuid),
  public.add_task_dependency(uuid,uuid,bigint,uuid),
  public.remove_task_dependency(uuid,uuid,bigint,uuid)
  to authenticated;

commit;
