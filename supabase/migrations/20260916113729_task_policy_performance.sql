begin;

-- Companion and agent sessions share the authenticated role. One policy per
-- table avoids evaluating multiple permissive SELECT policies for each row
-- while preserving the distinct caller predicates.
drop policy companion_task_read on public.tasks;
drop policy agent_task_read on public.tasks;
create policy task_read on public.tasks
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and private.task_can_access(project_id, 'read')
  );

drop policy companion_handoff_read on public.task_handoffs;
drop policy agent_handoff_read on public.task_handoffs;
create policy task_handoff_read on public.task_handoffs
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and private.task_can_access(project_id, 'read')
  );

drop policy companion_resource_read on public.task_resources;
drop policy agent_resource_read on public.task_resources;
create policy task_resource_read on public.task_resources
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and (
      ((select auth.jwt())->>'client_id') is null
      or (
        upload_status = 'verified'
        and private.agent_can_access_tasks(project_id, 'read')
      )
    )
  );

drop policy companion_handoff_resource_read on public.handoff_resource_refs;
drop policy agent_handoff_resource_read on public.handoff_resource_refs;
create policy handoff_resource_read on public.handoff_resource_refs
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and private.task_can_access(project_id, 'read')
  );

drop policy companion_task_event_read on public.task_events;
drop policy agent_task_event_read on public.task_events;
create policy task_event_read on public.task_events
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and private.task_can_access(project_id, 'read')
  );

-- Projects still keep their existing companion policy because it also governs
-- INSERT. Merge the two agent SELECT paths so tasks do not add a third policy.
drop policy agent_project_read on public.projects;
drop policy agent_task_project_read on public.projects;
create policy agent_project_read on public.projects
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and (
      public.agent_can_access(id, false)
      or private.agent_can_access_tasks(id, 'read')
    )
  );

commit;
