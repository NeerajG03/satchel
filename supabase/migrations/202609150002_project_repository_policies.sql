begin;

drop policy companion_project_repositories on public.project_repositories;
drop policy agent_project_repository_read on public.project_repositories;

create policy project_repository_read on public.project_repositories
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    and (((select auth.jwt())->>'client_id') is null or public.agent_can_access(project_id, false))
  );

create policy companion_project_repository_insert on public.project_repositories
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

create policy companion_project_repository_delete on public.project_repositories
  for delete to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

commit;
