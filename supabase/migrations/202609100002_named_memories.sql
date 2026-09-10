begin;

-- Preserve every existing body verbatim. Imported names are deterministic;
-- descriptions are excerpts, not inferred summaries, and can be edited later.
alter table public.memories rename column body to more_info;
alter table public.memories add column name text;
alter table public.memories add column description text;
update public.memories
set name = 'memory-' || id::text,
    description = left(more_info, 280);
alter table public.memories alter column name set not null;
alter table public.memories alter column description set not null;
alter table public.memories alter column more_info set default '';
alter table public.memories drop constraint memories_body_check;
alter table public.memories add constraint memories_name_check check (length(btrim(name)) between 1 and 100);
alter table public.memories add constraint memories_description_check check (length(btrim(description)) between 1 and 280);
alter table public.memories add constraint memories_more_info_check check (length(more_info) <= 40000);
create unique index memories_scope_name on public.memories(owner_id, project_id, lower(btrim(name)));

-- Old clients must reload, rather than silently create records without a summary.
drop function public.save_memory(uuid,uuid,text);
drop function public.correct_memory(uuid,integer,text);
grant insert(name, description) on public.memories to authenticated;
grant update(name, description) on public.memories to authenticated;

create function public.save_memory(p_id uuid, p_project_id uuid, p_name text, p_description text, p_more_info text)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  insert into public.memories(id, project_id, name, description, more_info)
    values(p_id, p_project_id, btrim(p_name), btrim(p_description), p_more_info) on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  if result.id is null or result.project_id is distinct from p_project_id
    or result.name is distinct from btrim(p_name) or result.description is distinct from btrim(p_description)
    or result.more_info is distinct from p_more_info then
    raise exception 'Memory request conflict' using errcode = '40001';
  end if;
  return result;
end;
$$;

create function public.correct_memory(p_id uuid, p_revision integer, p_name text, p_description text, p_more_info text)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  update public.memories set name = btrim(p_name), description = btrim(p_description), more_info = p_more_info
    where id = p_id and revision = p_revision returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = '40001';
  end if;
  return result;
end;
$$;

-- The index never includes the full details. Future hooks consume this shape
-- through an authorized transport; agent OAuth clients remain denied by RLS.
create function public.list_memories(p_project_id uuid)
returns table(id uuid, project_id uuid, name text, description text, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.name, m.description, m.revision, m.updated_at
  from public.memories m where m.project_id = p_project_id order by lower(m.name), m.id;
$$;

create function public.read_memory(p_project_id uuid, p_name text)
returns public.memories language plpgsql stable security invoker set search_path = '' as $$
declare result public.memories;
begin
  select * into result from public.memories
    where project_id = p_project_id and lower(btrim(name)) = lower(btrim(p_name));
  if result.id is null then
    raise exception 'Memory not found or unavailable' using errcode = 'P0002';
  end if;
  return result;
end;
$$;

revoke execute on function public.save_memory(uuid,uuid,text,text,text), public.correct_memory(uuid,integer,text,text,text), public.list_memories(uuid), public.read_memory(uuid,text) from public, anon;
grant execute on function public.save_memory(uuid,uuid,text,text,text), public.correct_memory(uuid,integer,text,text,text), public.list_memories(uuid), public.read_memory(uuid,text) to authenticated;

commit;
