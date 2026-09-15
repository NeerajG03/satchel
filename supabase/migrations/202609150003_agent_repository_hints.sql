begin;

-- Lifecycle command hooks can see the local Git origin, while authenticated
-- MCP hooks hold the agent grant. This short-lived handoff joins those two
-- facts without exposing either memory data or OAuth credentials locally.
create table public.agent_repository_hints (
  session_key text primary key check (
    length(session_key) between 16 and 200
    and session_key ~ '^[A-Za-z0-9_-]+$'
  ),
  provider text not null check (provider = 'github'),
  repository text not null check (
    repository = lower(repository)
    and repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
    and length(repository) <= 201
  ),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz not null default now()
);

create index agent_repository_hints_expiry
  on public.agent_repository_hints(expires_at);

alter table public.agent_repository_hints enable row level security;
revoke all on public.agent_repository_hints from public, anon, authenticated;

-- This is intentionally the only anonymous operation. It accepts no owner,
-- project, grant or memory fields and returns no data. The authenticated
-- consumer below remains responsible for authorization.
create function public.stage_agent_repository_hint(
  p_session_key text,
  p_provider text,
  p_repository text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_session_key is null
    or length(p_session_key) not between 16 and 200
    or p_session_key !~ '^[A-Za-z0-9_-]+$'
    or lower(btrim(p_provider)) <> 'github'
    or lower(btrim(p_repository)) !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
    or length(btrim(p_repository)) > 201 then
    raise exception 'Invalid repository hint' using errcode = '22023';
  end if;

  delete from public.agent_repository_hints where expires_at < now();
  insert into public.agent_repository_hints(session_key, provider, repository)
    values(p_session_key, 'github', lower(btrim(p_repository)))
    on conflict(session_key) do update set
      provider = excluded.provider,
      repository = excluded.repository,
      expires_at = now() + interval '5 minutes',
      created_at = now();
end;
$$;

-- Consuming a hint can select only a repository link owned by this user and
-- already present in this OAuth connection's project grant.
create function public.activate_agent_repository_hint(p_session_key text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  hint record;
  result uuid;
begin
  if public.agent_connection_status() is null then
    raise exception 'Connection unavailable' using errcode = '42501';
  end if;

  delete from public.agent_repository_hints
    where session_key = p_session_key and expires_at >= now()
    returning provider, repository into hint;

  if hint is null then return null; end if;

  select r.project_id into result
    from public.project_repositories r
    where r.owner_id = auth.uid()
      and r.provider = hint.provider
      and r.repository = hint.repository
      and public.agent_can_access(r.project_id, false);

  if result is null then return null; end if;
  perform public.select_agent_project(p_session_key, result);
  return result;
end;
$$;

revoke execute on function public.stage_agent_repository_hint(text,text,text),
  public.activate_agent_repository_hint(text) from public;
grant execute on function public.stage_agent_repository_hint(text,text,text)
  to anon, authenticated;
grant execute on function public.activate_agent_repository_hint(text)
  to authenticated;

commit;
