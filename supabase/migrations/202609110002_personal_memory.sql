begin;

-- NULL explicitly identifies the owner's personal scope. Existing project
-- foreign keys, row policies and immutable scope permissions are unchanged.
alter table public.memories alter column project_id drop not null;
create unique index memories_personal_name on public.memories(owner_id, lower(btrim(name)))
  where project_id is null;

-- The caller must pass its chosen scope; NULL is never an all-projects query.
create or replace function public.list_memories(p_project_id uuid)
returns table(id uuid, project_id uuid, name text, description text, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.name, m.description, m.revision, m.updated_at
  from public.memories m where m.project_id is not distinct from p_project_id
  order by lower(m.name), m.id;
$$;

create or replace function public.read_memory(p_project_id uuid, p_name text)
returns public.memories language plpgsql stable security invoker set search_path = '' as $$
declare result public.memories;
begin
  select * into result from public.memories
    where project_id is not distinct from p_project_id and lower(btrim(name)) = lower(btrim(p_name));
  if result.id is null then
    raise exception 'Memory not found or unavailable' using errcode = 'P0002';
  end if;
  return result;
end;
$$;

commit;
