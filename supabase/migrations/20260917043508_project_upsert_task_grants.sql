begin;

create or replace function public.upsert_project(
  p_request_id uuid,
  p_project_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_brief text,
  p_repository_action text default 'unchanged',
  p_repository text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  client text := auth.jwt()->>'client_id';
  is_agent boolean := client is not null;
  can_manage boolean := false;
  payload_hash text := md5(jsonb_build_object(
    'project_id', p_project_id,
    'expected_revision', p_expected_revision,
    'name', btrim(p_name),
    'brief', btrim(p_brief),
    'repository_action', p_repository_action,
    'repository', case when p_repository is null then null else lower(btrim(p_repository)) end
  )::text);
  previous public.project_write_requests;
  project public.projects;
  linked_project uuid;
  response jsonb;
begin
  if caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if is_agent then
    select exists (
      select 1 from public.agent_connections c
      where c.owner_id = caller
        and c.client_id = client
        and c.grant_id::text = auth.jwt()->>'satchel_grant_id'
        and c.revoked_at is null
        and (c.can_write or c.task_can_write)
    ) into can_manage;
  else
    can_manage := true;
  end if;
  if not can_manage then
    raise exception 'Project write unavailable' using errcode = '42501';
  end if;

  if p_repository_action not in ('unchanged', 'link', 'unlink')
    or (p_repository_action = 'unchanged' and p_repository is not null)
    or (p_repository_action in ('link', 'unlink') and (
      p_repository is null
      or lower(btrim(p_repository)) !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
      or length(btrim(p_repository)) > 201
    ))
    or (p_expected_revision is null and p_repository_action = 'unlink') then
    raise exception 'Invalid project change' using errcode = '23514';
  end if;

  select * into previous from public.project_write_requests
    where owner_id = caller and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.payload_hash <> payload_hash then
      raise exception 'Project request conflict' using errcode = 'PT409';
    end if;
    return previous.result;
  end if;

  if p_expected_revision is null then
    insert into public.projects(owner_id, id, name, brief)
      values(caller, p_project_id, btrim(p_name), btrim(p_brief))
      returning * into project;
  else
    if is_agent and not (
      public.agent_can_access(p_project_id, true)
      or private.agent_can_access_tasks(p_project_id, 'write')
    ) then
      raise exception 'Project write unavailable' using errcode = '42501';
    end if;
    update public.projects
      set name = btrim(p_name), brief = btrim(p_brief)
      where owner_id = caller and id = p_project_id and revision = p_expected_revision
      returning * into project;
    if project.id is null then
      raise exception 'Project changed or unavailable' using errcode = 'PT409';
    end if;
  end if;

  if p_repository_action = 'link' then
    insert into public.project_repositories(owner_id, project_id, provider, repository)
      values(caller, p_project_id, 'github', lower(btrim(p_repository)))
      on conflict(owner_id, provider, repository) do nothing;
    select project_id into linked_project from public.project_repositories
      where owner_id = caller and provider = 'github'
        and repository = lower(btrim(p_repository));
    if linked_project is distinct from p_project_id then
      raise exception 'Repository already belongs to another project' using errcode = 'PT409';
    end if;
  elsif p_repository_action = 'unlink' then
    delete from public.project_repositories
      where owner_id = caller and project_id = p_project_id and provider = 'github'
        and repository = lower(btrim(p_repository));
  end if;

  response := jsonb_build_object(
    'project', to_jsonb(project),
    'repositories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', repository.provider,
        'repository', repository.repository
      ) order by repository.provider, repository.repository)
      from public.project_repositories repository
      where repository.owner_id = caller and repository.project_id = p_project_id
    ), '[]'::jsonb),
    'grant_required', is_agent and not (
      public.agent_can_access(p_project_id, false)
      or private.agent_can_access_tasks(p_project_id, 'read')
    )
  );

  insert into public.project_write_requests(
    owner_id, request_id, payload_hash, project_id, result
  ) values (caller, p_request_id, payload_hash, p_project_id, response);
  return response;
exception when unique_violation then
  raise exception 'Project request conflict' using errcode = 'PT409';
end;
$$;

commit;
