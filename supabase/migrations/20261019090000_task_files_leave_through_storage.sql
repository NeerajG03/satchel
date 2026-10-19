begin;

-- Supabase now refuses a plain SQL delete on storage.objects (42501 from
-- storage.protect_delete), so a topic or task with a file could not be
-- deleted at all. Setting storage.allow_delete_query would only drop the row
-- and leave the file itself in the bucket, with nothing pointing at it. So the
-- routines hand the keys back and the app removes the files through the
-- Storage API, which takes both.

drop function if exists private.drop_task_files(text[]);

CREATE OR REPLACE FUNCTION public.delete_topic(p_id uuid, p_expected_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target public.topics;
  keys text[];
  memory_count integer;
  task_count integer;
begin
  perform private.companion_only();
  select * into target from public.topics
    where owner_id = auth.uid() and id = p_id for update;
  if target.id is null then
    raise exception 'Topic not found' using errcode = 'P0002';
  end if;
  if target.revision <> p_expected_revision then
    raise exception 'Topic revision conflict' using errcode = 'PT409';
  end if;

  select count(*) into memory_count from public.memories where owner_id = auth.uid() and topic_id = p_id;
  select count(*) into task_count from public.tasks where owner_id = auth.uid() and topic_id = p_id;
  select coalesce(array_agg(object_key), '{}') into keys from public.task_resources
    where owner_id = auth.uid() and topic_id = p_id and kind = 'storage_object' and object_key is not null;

  delete from public.task_write_requests w where w.owner_id = auth.uid()
    and exists (select 1 from public.tasks t where t.owner_id = w.owner_id and t.id = w.task_id and t.topic_id = p_id);
  update public.agent_connections set topic_ids = array_remove(topic_ids, p_id)
    where owner_id = auth.uid() and p_id = any(topic_ids);
  delete from public.topics where owner_id = auth.uid() and id = p_id;
  return jsonb_build_object('id', p_id, 'name', target.name,
    'memories_removed', memory_count, 'tasks_removed', task_count,
    'files_removed', cardinality(keys), 'file_keys', to_jsonb(keys));
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_task(p_id uuid, p_expected_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  select count(*) into removed_children from public.task_parent_edges
    where owner_id = auth.uid() and parent_task_id = p_id;
  delete from public.task_write_requests where owner_id = auth.uid() and task_id = p_id;
  delete from public.tasks where owner_id = auth.uid() and id = p_id;
  return jsonb_build_object('id', p_id, 'title', target.title, 'topic_id', target.topic_id,
    'files_removed', cardinality(keys), 'children_unparented', removed_children,
    'file_keys', to_jsonb(keys));
end;
$function$;

revoke all on function public.delete_topic(uuid, bigint) from public, anon, authenticated;
grant execute on function public.delete_topic(uuid, bigint) to authenticated;
revoke all on function public.delete_task(uuid, bigint) from public, anon, authenticated;
grant execute on function public.delete_task(uuid, bigint) to authenticated;

-- The files are removed after the rows are gone, so these cannot look the key
-- up in task_resources. Every key starts with the owner's id
-- (reserve_task_file builds it as owner/task/resource), and only the person
-- may remove, never an agent token, the same rule companion_only keeps.
-- The Storage API deletes with RETURNING, which needs the row to be readable
-- too, hence the select policy alongside.
do $storage$ begin if to_regclass('storage.objects') is not null then
  execute $policy$
    create policy task_file_owner_read on storage.objects
    for select to authenticated
    using (
      bucket_id = 'task-files'
      and split_part(name, '/', 1) = (select auth.uid())::text
      and ((select auth.jwt())->>'client_id') is null
    )
  $policy$;
  execute $policy$
    create policy task_file_owner_delete on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'task-files'
      and split_part(name, '/', 1) = (select auth.uid())::text
      and ((select auth.jwt())->>'client_id') is null
    )
  $policy$;
end if; end $storage$;

commit;
