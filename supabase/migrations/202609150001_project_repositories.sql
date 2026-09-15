begin;

-- Projects remain useful without code. A project may link to several repositories,
-- while one repository belongs to at most one project for each owner.
create table public.project_repositories (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null,
  provider text not null check (provider = lower(provider) and length(provider) between 1 and 40),
  repository text not null check (
    repository = lower(repository)
    and repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
    and length(repository) <= 201
  ),
  created_at timestamptz not null default now(),
  primary key (owner_id, provider, repository),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade
);

create index project_repositories_project on public.project_repositories(owner_id, project_id);
alter table public.project_repositories enable row level security;

create policy companion_project_repositories on public.project_repositories
  to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);

create policy agent_project_repository_read on public.project_repositories
  for select to authenticated
  using (owner_id = (select auth.uid()) and public.agent_can_access(project_id, false));

revoke all on public.project_repositories from public, anon, authenticated;
grant select, delete on public.project_repositories to authenticated;
grant insert(project_id, provider, repository) on public.project_repositories to authenticated;

create function public.link_project_repository(p_project_id uuid, p_provider text, p_repository text)
returns public.project_repositories language plpgsql security invoker set search_path = '' as $$
declare result public.project_repositories;
begin
  insert into public.project_repositories(project_id, provider, repository)
    values(p_project_id, lower(btrim(p_provider)), lower(btrim(p_repository)))
    on conflict(owner_id, provider, repository) do nothing;
  select * into result from public.project_repositories
    where owner_id = auth.uid() and provider = lower(btrim(p_provider))
      and repository = lower(btrim(p_repository));
  if result.project_id is distinct from p_project_id then
    raise exception 'Repository already belongs to another project' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

create function public.unlink_project_repository(p_project_id uuid, p_provider text, p_repository text)
returns void language sql security invoker set search_path = '' as $$
  delete from public.project_repositories
    where owner_id = auth.uid() and project_id = p_project_id
      and provider = lower(btrim(p_provider)) and repository = lower(btrim(p_repository));
$$;

-- Resolving a repository never expands a connection grant. RLS exposes only
-- links whose project is already authorized, then selection remains session-local.
create function public.select_agent_repository(p_session_key text, p_provider text, p_repository text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare result uuid;
begin
  select project_id into result from public.project_repositories
    where owner_id = auth.uid() and provider = lower(btrim(p_provider))
      and repository = lower(btrim(p_repository));
  if result is null then
    raise exception 'Repository is not linked to an authorized project' using errcode = 'P0002';
  end if;
  perform public.select_agent_project(p_session_key, result);
  return result;
end;
$$;

revoke execute on function public.link_project_repository(uuid,text,text),
  public.unlink_project_repository(uuid,text,text),
  public.select_agent_repository(text,text,text) from public, anon;
grant execute on function public.link_project_repository(uuid,text,text),
  public.unlink_project_repository(uuid,text,text),
  public.select_agent_repository(text,text,text) to authenticated;

commit;
