begin;

-- The web app used to make a topic and then set its short name in a second
-- call. When the short name was taken, the topic was already there under a
-- derived name, and the page said "already used", so people made it twice.
-- The short name now goes in with the create, and a refusal takes the topic
-- with it.
drop function public.create_topic(p_id uuid, p_name text, p_brief text);

CREATE FUNCTION public.create_topic(p_id uuid, p_name text, p_brief text, p_slug text DEFAULT NULL)
 RETURNS topics
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.topics;
begin
  insert into public.topics(id, name, brief) values(p_id, btrim(p_name), btrim(p_brief)) on conflict(id) do nothing;
  select * into result from public.topics where id = p_id;
  if result.id is null or result.name is distinct from btrim(p_name) or result.brief is distinct from btrim(p_brief) then
    raise exception 'Topic request conflict' using errcode = 'PT409';
  end if;
  if nullif(btrim(p_slug), '') is not null and btrim(p_slug) <> result.slug then
    perform public.set_slug('topic', p_id, btrim(p_slug));
    select * into result from public.topics where id = p_id;
  end if;
  return result;
end;
$function$;

revoke all on function public.create_topic(p_id uuid, p_name text, p_brief text, p_slug text) from public, anon, authenticated;
grant execute on function public.create_topic(p_id uuid, p_name text, p_brief text, p_slug text) to authenticated;

-- The task edit page saved fields, parent and each dependency as separate
-- calls. A refusal halfway left the first part saved under an error that said
-- nothing was. This runs the same routines, with the same checks, in one
-- transaction, so the save lands whole or not at all.
CREATE FUNCTION public.save_task_edit(
  p_request_id uuid, p_id uuid, p_expected_revision bigint,
  p_title text DEFAULT NULL, p_outcome text DEFAULT NULL, p_why text DEFAULT NULL,
  p_done_when text[] DEFAULT NULL, p_next_action text DEFAULT NULL, p_priority text DEFAULT NULL,
  p_set_parent boolean DEFAULT false, p_parent_task_id uuid DEFAULT NULL,
  p_remove_dependency_ids uuid[] DEFAULT '{}', p_add_dependency_ids uuid[] DEFAULT '{}')
 RETURNS tasks
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  revision bigint := p_expected_revision;
  step integer := 0;
  dep uuid;
  result public.tasks;
  -- Each inner routine keeps its own receipt, so each gets its own request id,
  -- derived from the caller's so that a retry replays rather than repeats.
  next_request uuid;
begin
  if p_title is not null then
    step := step + 1;
    next_request := md5(p_request_id::text || ':' || step)::uuid;
    result := public.update_task(next_request, p_id, revision, p_title, p_outcome, p_why, p_done_when, p_next_action, p_priority);
    revision := result.revision;
  end if;
  if p_set_parent then
    step := step + 1;
    next_request := md5(p_request_id::text || ':' || step)::uuid;
    revision := (public.set_task_parent(next_request, p_id, revision, p_parent_task_id)->'task'->>'revision')::bigint;
  end if;
  foreach dep in array coalesce(p_remove_dependency_ids, '{}') loop
    step := step + 1;
    next_request := md5(p_request_id::text || ':' || step)::uuid;
    revision := (public.remove_task_dependency(next_request, p_id, revision, dep)->'task'->>'revision')::bigint;
  end loop;
  foreach dep in array coalesce(p_add_dependency_ids, '{}') loop
    step := step + 1;
    next_request := md5(p_request_id::text || ':' || step)::uuid;
    revision := (public.add_task_dependency(next_request, p_id, revision, dep)->'task'->>'revision')::bigint;
  end loop;
  select * into result from public.tasks where owner_id = auth.uid() and id = p_id;
  if result.id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  return result;
end;
$function$;

revoke all on function public.save_task_edit(uuid, uuid, bigint, text, text, text, text[], text, text, boolean, uuid, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.save_task_edit(uuid, uuid, bigint, text, text, text, text[], text, text, boolean, uuid, uuid[], uuid[]) to authenticated;

commit;
