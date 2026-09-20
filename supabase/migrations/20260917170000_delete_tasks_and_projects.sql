begin;

-- Deleting is a person's action only. Agent tokens never get it, the
-- Apps consent page never offers it, and the web UI asks first.
create function private.companion_only() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or ((select auth.jwt())->>'client_id') is not null then
    raise exception 'Delete unavailable' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function private.companion_only() from public, anon, authenticated;
grant execute on function private.companion_only() to authenticated;

create function private.drop_task_files(p_object_keys text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_object_keys is null or cardinality(p_object_keys) = 0 then return; end if;
  if to_regclass('storage.objects') is null then return; end if;
  execute 'delete from storage.objects where bucket_id = ''task-files'' and name = any($1)' using p_object_keys;
end;
$$;
revoke execute on function private.drop_task_files(text[]) from public, anon, authenticated;

create function public.delete_task(p_id uuid, p_expected_revision bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  target public.tasks;
  keys text[];
  removed_children integer;
begin
  perform private.companion_only();
  select * into target from public.tasks
    where owner_id = auth.uid() and id = p_id for update;
  if target.id is null then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  if target.revision <> p_expected_revision then
    raise exception 'Task revision conflict' using errcode = 'PT409';
  end if;

  select coalesce(array_agg(object_key), '{}') into keys from public.task_resources
    where owner_id = auth.uid() and task_id = p_id and kind = 'storage_object' and object_key is not null;
  perform private.drop_task_files(keys);

  select count(*) into removed_children from public.task_parent_edges
    where owner_id = auth.uid() and parent_task_id = p_id;
  delete from public.task_write_requests where owner_id = auth.uid() and task_id = p_id;
  delete from public.tasks where owner_id = auth.uid() and id = p_id;
  return jsonb_build_object('id', p_id, 'title', target.title, 'project_id', target.project_id,
    'files_removed', cardinality(keys), 'children_unparented', removed_children);
end;
$$;

create function public.delete_project(p_id uuid, p_expected_revision bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  target public.projects;
  keys text[];
  memory_count integer;
  task_count integer;
begin
  perform private.companion_only();
  select * into target from public.projects
    where owner_id = auth.uid() and id = p_id for update;
  if target.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  if target.revision <> p_expected_revision then
    raise exception 'Project revision conflict' using errcode = 'PT409';
  end if;

  select count(*) into memory_count from public.memories where owner_id = auth.uid() and project_id = p_id;
  select count(*) into task_count from public.tasks where owner_id = auth.uid() and project_id = p_id;
  select coalesce(array_agg(object_key), '{}') into keys from public.task_resources
    where owner_id = auth.uid() and project_id = p_id and kind = 'storage_object' and object_key is not null;
  perform private.drop_task_files(keys);

  delete from public.task_write_requests w where w.owner_id = auth.uid()
    and exists (select 1 from public.tasks t where t.owner_id = w.owner_id and t.id = w.task_id and t.project_id = p_id);
  update public.agent_connections set project_ids = array_remove(project_ids, p_id)
    where owner_id = auth.uid() and p_id = any(project_ids);
  delete from public.projects where owner_id = auth.uid() and id = p_id;
  return jsonb_build_object('id', p_id, 'name', target.name,
    'memories_removed', memory_count, 'tasks_removed', task_count, 'files_removed', cardinality(keys));
end;
$$;

revoke execute on function public.delete_task(uuid, bigint), public.delete_project(uuid, bigint)
  from public, anon;
grant execute on function public.delete_task(uuid, bigint), public.delete_project(uuid, bigint)
  to authenticated;

commit;
