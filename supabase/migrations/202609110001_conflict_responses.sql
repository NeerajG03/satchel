begin;

-- Expected application conflicts must not trigger PostgREST serialization retries.
-- PT409 produces an ordinary HTTP 409 and preserves existing grants.

create or replace function public.create_project(p_id uuid, p_name text, p_brief text)
returns public.projects language plpgsql security invoker set search_path = '' as $$
declare result public.projects;
begin
  insert into public.projects(id, name, brief) values(p_id, btrim(p_name), btrim(p_brief)) on conflict(id) do nothing;
  select * into result from public.projects where id = p_id;
  if result.id is null or result.name is distinct from btrim(p_name) or result.brief is distinct from btrim(p_brief) then
    raise exception 'Project request conflict' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

create or replace function public.save_memory(p_id uuid, p_project_id uuid, p_name text, p_description text, p_more_info text)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  insert into public.memories(id, project_id, name, description, more_info)
    values(p_id, p_project_id, btrim(p_name), btrim(p_description), p_more_info) on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  if result.id is null or result.project_id is distinct from p_project_id
    or result.name is distinct from btrim(p_name) or result.description is distinct from btrim(p_description)
    or result.more_info is distinct from p_more_info then
    raise exception 'Memory request conflict' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

create or replace function public.correct_memory(p_id uuid, p_revision integer, p_name text, p_description text, p_more_info text)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  update public.memories set name = btrim(p_name), description = btrim(p_description), more_info = p_more_info
    where id = p_id and revision = p_revision returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

commit;
