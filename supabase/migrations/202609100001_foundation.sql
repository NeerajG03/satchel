begin;

create table public.projects (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  brief text not null default '' check (length(brief) <= 1000),
  created_at timestamptz not null default now(),
  unique (owner_id, id)
);

create table public.memories (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null,
  body text not null check (length(btrim(body)) between 1 and 4000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade
);

create index memories_project_updated on public.memories(owner_id, project_id, updated_at desc);
alter table public.projects enable row level security;
alter table public.memories enable row level security;

-- Agent tokens are denied until a separately tested connection-grant model exists.
create policy companion_projects on public.projects to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);
create policy companion_memories on public.memories to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);

revoke all on public.projects, public.memories from anon, authenticated;
grant select on public.projects, public.memories to authenticated;
grant insert(id, name, brief) on public.projects to authenticated;
grant insert(id, project_id, body) on public.memories to authenticated;
grant update(body) on public.memories to authenticated;
grant delete on public.memories to authenticated;

create function public.stamp_memory_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger stamp_memory_revision before update on public.memories
  for each row execute function public.stamp_memory_revision();

-- Stable client IDs make a lost response safe to retry. An ID reused for a
-- different payload is a conflict, never an overwrite.
create function public.create_project(p_id uuid, p_name text, p_brief text)
returns public.projects language plpgsql security invoker set search_path = '' as $$
declare result public.projects;
begin
  insert into public.projects(id, name, brief) values(p_id, btrim(p_name), btrim(p_brief)) on conflict(id) do nothing;
  select * into result from public.projects where id = p_id;
  if result.id is null or result.name is distinct from btrim(p_name) or result.brief is distinct from btrim(p_brief) then
    raise exception 'Project request conflict' using errcode = '40001';
  end if;
  return result;
end;
$$;

create function public.save_memory(p_id uuid, p_project_id uuid, p_body text)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  insert into public.memories(id, project_id, body) values(p_id, p_project_id, btrim(p_body)) on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  if result.id is null or result.project_id is distinct from p_project_id or result.body is distinct from btrim(p_body) then
    raise exception 'Memory request conflict' using errcode = '40001';
  end if;
  return result;
end;
$$;

create function public.correct_memory(p_id uuid, p_revision integer, p_body text)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  update public.memories set body = btrim(p_body) where id = p_id and revision = p_revision returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = '40001';
  end if;
  return result;
end;
$$;

revoke execute on function public.stamp_memory_revision(), public.create_project(uuid,text,text), public.save_memory(uuid,uuid,text), public.correct_memory(uuid,integer,text) from public, anon;
grant execute on function public.create_project(uuid,text,text), public.save_memory(uuid,uuid,text), public.correct_memory(uuid,integer,text) to authenticated;

commit;
