begin;

-- A repository is evidence about a project, not an identifier for one.
--
-- `primary key (owner_id, provider, repository)` said the opposite, and
-- link_project_repository enforced it with PT409. That constraint was bought
-- for the resolver's convenience: one row in, one uuid out, nothing to decide.
-- It is not true about the world. The very first projects migration says
-- "Projects remain useful without code", so a project is a collection of
-- context that can span codebases and non-code things, and a monorepo holds
-- several units of work. Making the git layout dictate the project layout is
-- backwards.
--
-- Many codebases to one project already worked and is already in use:
-- email-self-serve links cbx1/backend, cbx1/centralized_rate_limiter and
-- cbx1/infra-configurations. This is the other direction, and it is about to be
-- needed: data-model-2-0 is work inside cbx1/backend.
--
-- What it costs is exactly what the constraint was bought for. A repository
-- with more than one project cannot resolve to one on its own, so the resolvers
-- stop picking arbitrarily and say so instead. `select ... into` on a
-- multi-row result takes whichever row came first, silently, which would have
-- made the scope depend on the planner.
--
-- Exactly one candidate still activates with no model involved and no tool
-- call, which stays the common case and is the property that fixed capture
-- today.

alter table public.project_repositories
  drop constraint project_repositories_pkey,
  add primary key (owner_id, provider, repository, project_id);
-- No separate index for the lookup: the new key's leading columns are exactly
-- (owner_id, provider, repository), so the by-repository read is still served.

-- Linking a second project is now a second row rather than a refusal.
create or replace function public.link_project_repository(p_project_id uuid, p_provider text, p_repository text)
returns public.project_repositories language plpgsql security invoker set search_path = '' as $$
declare result public.project_repositories;
begin
  insert into public.project_repositories(project_id, provider, repository)
    values(p_project_id, lower(btrim(p_provider)), lower(btrim(p_repository)))
    on conflict(owner_id, provider, repository, project_id) do nothing;
  select * into result from public.project_repositories
    where owner_id = auth.uid() and project_id = p_project_id
      and provider = lower(btrim(p_provider))
      and repository = lower(btrim(p_repository));
  if result.project_id is null then
    raise exception 'Repository link unavailable' using errcode = '42501';
  end if;
  return result;
end;
$$;

CREATE OR REPLACE FUNCTION public.upsert_project(p_request_id uuid, p_project_id uuid, p_expected_revision bigint, p_name text, p_brief text, p_repository_action text DEFAULT 'unchanged'::text, p_repository text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- No longer refused when the repository already has a project. The conflict
    -- target carries project_id now, so a second link is a second row rather
    -- than a PT409.
    insert into public.project_repositories(owner_id, project_id, provider, repository)
      values(caller, p_project_id, 'github', lower(btrim(p_repository)))
      on conflict(owner_id, provider, repository, project_id) do nothing;
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
$function$;

-- Selecting by repository is selecting by an identifier, so it only works while
-- the repository is one. RLS exposes only links whose project this connection
-- may already read, so the count is per connection: a repository shared by two
-- projects is unambiguous to an app granted one of them.
create or replace function public.select_agent_repository(p_session_key text, p_provider text, p_repository text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare candidates uuid[];
begin
  select array_agg(project_id) into candidates from public.project_repositories
    where owner_id = auth.uid() and provider = lower(btrim(p_provider))
      and repository = lower(btrim(p_repository));
  if candidates is null then
    raise exception 'Repository is not linked to an authorized project' using errcode = 'P0002';
  end if;
  if array_length(candidates, 1) > 1 then
    raise exception 'Repository is linked to % projects in this grant; select by project_id',
      array_length(candidates, 1) using errcode = 'PT300';
  end if;
  perform public.select_agent_project(p_session_key, candidates[1]);
  return candidates[1];
end;
$$;

-- Consuming a hint can select only a repository link owned by this user and
-- already present in this OAuth connection's project grant.
--
-- Rewritten so the hint is read before it is deleted rather than by
-- `delete ... returning`: an ambiguous repository must leave the hint staged,
-- because the candidates are still worth offering and a consumed hint cannot be
-- read back.
create or replace function public.activate_agent_repository_hint(p_session_key text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  hint record;
  candidates uuid[];
begin
  if public.agent_connection_status() is null then
    raise exception 'Connection unavailable' using errcode = '42501';
  end if;

  select h.provider, h.repository into hint from public.agent_repository_hints h
    where h.session_key = p_session_key and h.expires_at >= now();
  if hint.repository is null then return null; end if;

  select array_agg(r.project_id) into candidates
    from public.project_repositories r
    where r.owner_id = auth.uid()
      and r.provider = hint.provider
      and r.repository = hint.repository
      and public.agent_can_access(r.project_id, false);

  -- Nothing to resolve to: the hint has been handled and is dropped, the same
  -- as before. Several candidates is not a failure, so the hint stays and
  -- agent_repository_candidates can still read it.
  if candidates is null then
    delete from public.agent_repository_hints where session_key = p_session_key;
    return null;
  end if;
  if array_length(candidates, 1) > 1 then return null; end if;

  delete from public.agent_repository_hints where session_key = p_session_key;
  perform public.select_agent_project(p_session_key, candidates[1]);
  return candidates[1];
end;
$$;

-- What to offer when the repository names more than one project. Security
-- definer because agent_repository_hints is revoked from authenticated
-- entirely; agent_can_access is what keeps this inside the grant.
create function public.agent_repository_candidates(p_session_key text)
returns table(project_id uuid, slug text, name text, brief text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.slug, p.name, p.brief
  from public.agent_repository_hints h
  join public.project_repositories r
    on r.provider = h.provider and r.repository = h.repository
  join public.projects p on p.id = r.project_id and p.owner_id = r.owner_id
  where h.session_key = p_session_key and h.expires_at >= now()
    and r.owner_id = auth.uid()
    and public.agent_can_access(r.project_id, false)
  order by p.name;
$$;

revoke execute on function public.agent_repository_candidates(text) from public, anon;
grant execute on function public.agent_repository_candidates(text) to authenticated;

commit;
