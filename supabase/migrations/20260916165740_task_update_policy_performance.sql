begin;

drop policy companion_task_update_read on public.task_updates;
drop policy agent_task_update_read on public.task_updates;
create policy task_update_read on public.task_updates
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and private.task_can_access(project_id, 'read')
  );

drop policy companion_task_update_resource_read on public.task_update_resource_refs;
drop policy agent_task_update_resource_read on public.task_update_resource_refs;
create policy task_update_resource_read on public.task_update_resource_refs
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and private.task_can_access(project_id, 'read')
  );

commit;
