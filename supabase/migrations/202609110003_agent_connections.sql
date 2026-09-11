begin;

create table public.agent_connections (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id text not null check (length(client_id) between 1 and 200),
  label text not null check (length(btrim(label)) between 1 and 100),
  personal boolean not null default false,
  project_ids uuid[] not null default '{}',
  can_write boolean not null default false,
  grant_id uuid not null default gen_random_uuid(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(owner_id, client_id)
);
alter table public.agent_connections enable row level security;
create policy companion_connections on public.agent_connections to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);
revoke all on public.agent_connections from public, anon, authenticated;
grant select on public.agent_connections to authenticated;

-- Definer routines expose only intentional grant changes; callers cannot edit
-- ownership, grant generation, or revocation state directly.
create function public.authorize_agent(p_client_id text, p_label text, p_personal boolean,
  p_project_ids uuid[], p_can_write boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or auth.jwt()->>'client_id' is not null then
    raise exception 'Companion sign-in required' using errcode = '42501';
  end if;
  if p_project_ids is null or cardinality(p_project_ids) > 100
    or array_position(p_project_ids, null) is not null
    or exists (select 1 from unnest(p_project_ids) p where not exists
      (select 1 from public.projects where id=p and owner_id=auth.uid())) then
    raise exception 'Invalid project selection' using errcode = '42501';
  end if;
  if not p_personal and cardinality(p_project_ids)=0 then
    raise exception 'Select a memory scope' using errcode='23514';
  end if;
  insert into public.agent_connections(owner_id,client_id,label,personal,project_ids,can_write)
    values(auth.uid(),p_client_id,btrim(p_label),p_personal,p_project_ids,p_can_write)
    on conflict(owner_id,client_id) do update set label=excluded.label,
      personal=excluded.personal, project_ids=excluded.project_ids,
      can_write=excluded.can_write, revoked_at=null, grant_id=gen_random_uuid();
end;
$$;

create function public.revoke_agent(p_client_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or auth.jwt()->>'client_id' is not null then
    raise exception 'Companion sign-in required' using errcode='42501';
  end if;
  update public.agent_connections set revoked_at=now(), grant_id=gen_random_uuid()
    where owner_id=auth.uid() and client_id=p_client_id;
end;
$$;

create function public.agent_can_access(p_project_id uuid, p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.agent_connections c
    where c.owner_id=auth.uid() and c.client_id=auth.jwt()->>'client_id'
      and c.grant_id::text=auth.jwt()->>'satchel_grant_id' and c.revoked_at is null
      and (not p_write or c.can_write)
      and (case when p_project_id is null then c.personal else p_project_id=any(c.project_ids) end));
$$;

create function public.agent_connection_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('client_id',c.client_id,'label',c.label,'personal',c.personal,
    'project_ids',c.project_ids,'can_write',c.can_write)
  from public.agent_connections c where c.owner_id=auth.uid()
    and c.client_id=auth.jwt()->>'client_id' and c.grant_id::text=auth.jwt()->>'satchel_grant_id'
    and c.revoked_at is null;
$$;

create policy agent_project_read on public.projects for select to authenticated
  using (owner_id=(select auth.uid()) and public.agent_can_access(id,false));
create policy agent_memory_read on public.memories for select to authenticated
  using (owner_id=(select auth.uid()) and public.agent_can_access(project_id,false));
create policy agent_memory_insert on public.memories for insert to authenticated
  with check (owner_id=(select auth.uid()) and public.agent_can_access(project_id,true));
create policy agent_memory_update on public.memories for update to authenticated
  using (owner_id=(select auth.uid()) and public.agent_can_access(project_id,true))
  with check (owner_id=(select auth.uid()) and public.agent_can_access(project_id,true));
create policy agent_memory_delete on public.memories for delete to authenticated
  using (owner_id=(select auth.uid()) and public.agent_can_access(project_id,true));

create table public.agent_session_scopes (
  owner_id uuid not null,
  client_id text not null,
  session_key text not null check (length(session_key) between 1 and 200),
  grant_id uuid not null,
  project_id uuid,
  updated_at timestamptz not null default now(),
  primary key(owner_id,client_id,session_key),
  foreign key(owner_id,client_id) references public.agent_connections(owner_id,client_id) on delete cascade,
  foreign key(owner_id,project_id) references public.projects(owner_id,id) on delete cascade
);
alter table public.agent_session_scopes enable row level security;
revoke all on public.agent_session_scopes from public,anon,authenticated;
create function public.select_agent_project(p_session_key text,p_project_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if public.agent_connection_status() is null or
    (p_project_id is not null and not public.agent_can_access(p_project_id,false)) then
    raise exception 'Scope unavailable' using errcode='42501';
  end if;
  insert into public.agent_session_scopes(owner_id,client_id,session_key,grant_id,project_id)
    values(auth.uid(),auth.jwt()->>'client_id',p_session_key,(auth.jwt()->>'satchel_grant_id')::uuid,p_project_id)
    on conflict(owner_id,client_id,session_key) do update set
      grant_id=excluded.grant_id,project_id=excluded.project_id,updated_at=now();
end;
$$;
create function public.agent_active_project(p_session_key text) returns uuid
language sql stable security definer set search_path='' as $$
  select project_id from public.agent_session_scopes where owner_id=auth.uid()
    and client_id=auth.jwt()->>'client_id' and session_key=p_session_key
    and grant_id::text=auth.jwt()->>'satchel_grant_id' and public.agent_can_access(project_id,false);
$$;
revoke all on function public.select_agent_project(text,uuid),public.agent_active_project(text) from public,anon;
grant execute on function public.select_agent_project(text,uuid),public.agent_active_project(text) to authenticated;

-- Selected in Supabase Auth > Hooks. Regular companion tokens are untouched.
-- A generation claim prevents old access tokens regaining access on re-consent.
create function public.satchel_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare claims jsonb := event->'claims'; generation uuid;
begin
  if coalesce(event->>'client_id', claims->>'client_id') is null then return event; end if;
  select grant_id into generation from public.agent_connections
    where owner_id=(event->>'user_id')::uuid
      and client_id=coalesce(event->>'client_id',claims->>'client_id') and revoked_at is null;
  claims := claims || jsonb_build_object('aud',jsonb_build_array('authenticated','https://satchel-pi.vercel.app/api/mcp'));
  claims := (claims - 'satchel_grant_id') || jsonb_build_object('satchel_grant_id',generation);
  return jsonb_set(event,'{claims}',claims);
end;
$$;

revoke all on function public.authorize_agent(text,text,boolean,uuid[],boolean),
  public.revoke_agent(text), public.agent_can_access(uuid,boolean),
  public.agent_connection_status(), public.satchel_access_token_hook(jsonb) from public, anon;
grant execute on function public.authorize_agent(text,text,boolean,uuid[],boolean),
  public.revoke_agent(text), public.agent_can_access(uuid,boolean), public.agent_connection_status() to authenticated;
-- Supabase creates this role; the local SQL harness mirrors it.
grant execute on function public.satchel_access_token_hook(jsonb) to supabase_auth_admin;

commit;
