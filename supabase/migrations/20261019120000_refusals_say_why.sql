begin;

-- Every refusal now says why in its hint, as satchel:<reason>, so the web app
-- reads the reason instead of the sentence. Postgres gives 42501 to every
-- refusal, and the sentence is a log line that can be reworded, so neither
-- was safe to decide on. The worst case was a signed-in person told to sign
-- in again.
--
-- Guards that refused both a missing session and an app token with one raise
-- now raise twice: satchel:session when auth.uid() is null, and
-- satchel:app_token when the token carries a client_id.
--
-- Each body below is the latest definition, read back from the database after
-- every earlier migration, with only the raise lines changed. A raise without
-- a satchel: hint fails tests/web-error-text.test.mjs.

CREATE OR REPLACE FUNCTION private.companion_only()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select auth.uid()) is null then
    raise exception 'Delete unavailable' using errcode = '42501', hint = 'satchel:session';
  end if;
  if ((select auth.jwt())->>'client_id') is not null then
    raise exception 'Delete unavailable' using errcode = '42501', hint = 'satchel:app_token';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.require_companion()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  if ((select auth.jwt()) ->> 'client_id') is not null then
    raise exception 'Only you can change this, from the web app' using errcode = '42501', hint = 'satchel:app_token';
  end if;
  return caller;
end;
$function$;

CREATE OR REPLACE FUNCTION public.activate_agent_repository_hint(p_session_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  hint record;
  candidates uuid[];
begin
  if public.agent_connection_status() is null then
    raise exception 'Connection unavailable' using errcode = '42501', hint = 'satchel:refused:connection';
  end if;

  select h.provider, h.repository into hint from public.agent_repository_hints h
    where h.session_key = p_session_key and h.expires_at >= now();
  if hint.repository is null then return null; end if;

  select array_agg(r.topic_id) into candidates
    from public.topic_repositories r
    where r.owner_id = auth.uid()
      and r.provider = hint.provider
      and r.repository = hint.repository
      and public.agent_can_access(r.topic_id, false);

  -- Nothing to resolve to: the hint has been handled and is dropped, the same
  -- as before. Several candidates is not a failure, so the hint stays and
  -- agent_repository_candidates can still read it.
  if candidates is null then
    delete from public.agent_repository_hints where session_key = p_session_key;
    return null;
  end if;
  if array_length(candidates, 1) > 1 then return null; end if;

  delete from public.agent_repository_hints where session_key = p_session_key;
  perform public.select_agent_topic(p_session_key, candidates[1]);
  return candidates[1];
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_task_comment(p_request_id uuid, p_id uuid, p_task_id uuid, p_body text, p_resource_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS task_updates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  task_result public.tasks;
  update_result public.task_updates;
  previous public.task_write_requests;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'body', p_body,
    'resource_ids', p_resource_ids
  )::text);
begin
  select * into task_result from public.tasks
    where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(task_result.topic_id, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;

  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'add_task_comment' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into update_result from public.task_updates
      where owner_id = auth.uid() and id = previous.update_id;
    return update_result;
  end if;

  if p_resource_ids is null or array_position(p_resource_ids, null) is not null
    or (select count(*) from unnest(p_resource_ids) value)
      <> (select count(distinct value) from unnest(p_resource_ids) value)
    or exists (
      select 1 from unnest(p_resource_ids) value
      where not exists (
        select 1 from public.task_resources r
        where r.owner_id = auth.uid()
          and r.topic_id is not distinct from task_result.topic_id
          and r.task_id = p_task_id and r.id = value and r.upload_status = 'verified'
      )
    ) then
    raise exception 'Invalid comment resource' using errcode = '23514', hint = 'satchel:invalid:task_resource';
  end if;

  insert into public.task_updates(
    owner_id, topic_id, task_id, id, kind, body, created_by
  ) values (
    auth.uid(), task_result.topic_id, p_task_id, p_id, 'comment', btrim(p_body), actor
  ) returning * into update_result;

  insert into public.task_update_resource_refs(
    owner_id, topic_id, task_id, update_id, resource_id
  ) select auth.uid(), task_result.topic_id, p_task_id, p_id, value
    from unnest(p_resource_ids) value;

  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, to_revision, details, created_by
  ) values (
    auth.uid(), task_result.topic_id, p_task_id, 'comment_added', task_result.revision,
    jsonb_build_object('update_id', p_id, 'resource_count', cardinality(p_resource_ids)), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, update_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'add_task_comment', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return update_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_task_dependency(p_request_id uuid, p_task_id uuid, p_expected_revision bigint, p_depends_on_task_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  task_result public.tasks;
  previous public.task_write_requests;
  current_topic uuid;
  current_scope text;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'depends_on_task_id', p_depends_on_task_id
  )::text);
begin
  select topic_id, scope_key into current_topic, current_scope
    from public.tasks where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_topic, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'add_task_dependency' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into task_result from public.tasks
      where owner_id = auth.uid() and id = previous.task_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'depends_on_task_id', previous.related_task_id);
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text), hashtext(current_scope));
  select * into task_result from public.tasks
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    for update;
  if not found then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;
  if p_depends_on_task_id = p_task_id or not exists (
    select 1 from public.tasks candidate
    where candidate.owner_id = auth.uid() and candidate.scope_key = current_scope
      and candidate.id = p_depends_on_task_id
  ) then
    raise exception 'Dependency task unavailable in this scope' using errcode = '23514', hint = 'satchel:invalid:dependency_scope';
  end if;
  if exists (
    with recursive prerequisites(id) as (
      select p_depends_on_task_id
      union
      select edge.depends_on_task_id
      from public.task_dependencies edge
      join prerequisites on edge.task_id = prerequisites.id
      where edge.owner_id = auth.uid() and edge.scope_key = current_scope
    )
    select 1 from prerequisites where id = p_task_id
  ) then
    raise exception 'Task dependency cycle' using errcode = '23514', hint = 'satchel:invalid:dependency_cycle';
  end if;

  if exists (
    select 1 from public.task_dependencies
    where owner_id = auth.uid() and task_id = p_task_id
      and depends_on_task_id = p_depends_on_task_id
  ) then
    insert into public.task_write_requests(
      owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
    ) values (
      auth.uid(), p_request_id, 'add_task_dependency', payload_hash,
      p_task_id, p_depends_on_task_id, task_result.revision
    );
    return jsonb_build_object('task', to_jsonb(task_result), 'depends_on_task_id', p_depends_on_task_id);
  end if;

  insert into public.task_dependencies(
    owner_id, topic_id, task_id, depends_on_task_id, created_by
  ) values (auth.uid(), current_topic, p_task_id, p_depends_on_task_id, actor);
  update public.tasks set revision = revision + 1, updated_by = actor,
    updated_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_task_id
    returning * into task_result;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, 'dependency_added',
    p_expected_revision, task_result.revision,
    jsonb_build_object('depends_on_task_id', p_depends_on_task_id), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'add_task_dependency', payload_hash,
    p_task_id, p_depends_on_task_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'depends_on_task_id', p_depends_on_task_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_task_resource(p_request_id uuid, p_id uuid, p_task_id uuid, p_expected_revision bigint, p_label text, p_url text, p_resource_type text DEFAULT 'reference'::text, p_provider text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  task_result public.tasks;
  resource_result public.task_resources;
  previous public.task_write_requests;
  current_topic uuid;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'label', btrim(p_label), 'url', p_url, 'resource_type', p_resource_type,
    'provider', p_provider
  )::text);
begin
  select topic_id into current_topic from public.tasks
    where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_topic, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'add_task_resource' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into task_result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    select * into resource_result from public.task_resources where owner_id = auth.uid() and id = previous.resource_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'resource', to_jsonb(resource_result));
  end if;

  update public.tasks set revision = revision + 1, updated_by = actor, updated_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    returning * into task_result;
  if task_result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;
  insert into public.task_resources(
    owner_id, topic_id, task_id, id, kind, resource_type, label,
    external_url, external_provider, upload_status, created_by, verified_at
  ) values (
    auth.uid(), current_topic, p_task_id, p_id, 'external_url', p_resource_type,
    btrim(p_label), p_url, nullif(btrim(p_provider), ''), 'verified', actor, now()
  ) returning * into resource_result;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, 'resource_added',
    p_expected_revision, task_result.revision,
    jsonb_build_object('resource_id', p_id, 'kind', 'external_url'), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'add_task_resource', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'resource', to_jsonb(resource_result));
end;
$function$;

CREATE OR REPLACE FUNCTION public.affirm_memory(p_id uuid, p_trace text DEFAULT NULL::text, p_document uuid DEFAULT NULL::uuid)
 RETURNS memories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.memories;
begin
  perform private.attribute(p_trace, p_document, null);
  update public.memories set affirmed_at = now(), mentions = mentions + 1, band = 'said'
    where id = p_id and ended_at is null returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:memory';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.agent_repository_hint_exists(p_session_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.agent_connection_status() is null then
    raise exception 'Connection unavailable' using errcode = '42501', hint = 'satchel:refused:connection';
  end if;
  return exists(
    select 1 from public.agent_repository_hints
      where session_key = p_session_key and expires_at >= now()
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.authorize_agent_v3(p_client_id text, p_label text, p_personal boolean, p_all_topics boolean, p_topic_ids uuid[], p_can_write boolean, p_task_personal boolean, p_task_all_topics boolean, p_task_topic_ids uuid[], p_task_can_write boolean, p_task_can_upload boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  next_grant uuid := gen_random_uuid();
  -- A blanket grant keeps no list. Holding both would leave the Apps page and
  -- agent_connection_status showing a frozen set of names that no longer
  -- decides anything, which is worse than showing none.
  memory_ids uuid[] := case when p_all_topics then '{}'::uuid[] else p_topic_ids end;
  task_ids uuid[] := case when p_task_all_topics then '{}'::uuid[] else p_task_topic_ids end;
begin
  if auth.uid() is null then
    raise exception 'Companion sign-in required' using errcode = '42501', hint = 'satchel:session';
  end if;
  if auth.jwt()->>'client_id' is not null then
    raise exception 'Companion sign-in required' using errcode = '42501', hint = 'satchel:app_token';
  end if;
  if p_topic_ids is null or p_task_topic_ids is null
    or cardinality(p_topic_ids) > 100 or cardinality(p_task_topic_ids) > 100
    or array_position(p_topic_ids, null) is not null
    or array_position(p_task_topic_ids, null) is not null
    or exists (
      select 1 from unnest(p_topic_ids || p_task_topic_ids) p
      where not exists (
        select 1 from public.topics where id = p and owner_id = auth.uid()
      )
    ) then
    raise exception 'Invalid topic selection' using errcode = '42501', hint = 'satchel:refused:topic_selection';
  end if;
  -- A blanket grant is a scope, so it satisfies this on its own.
  if not p_personal and not p_all_topics and cardinality(p_topic_ids) = 0
    and not p_task_personal and not p_task_all_topics and cardinality(p_task_topic_ids) = 0 then
    raise exception 'Select a memory or task scope' using errcode = '23514', hint = 'satchel:invalid:no_scope';
  end if;

  insert into public.agent_connections(
    owner_id, client_id, label, personal, all_topics, topic_ids, can_write,
    task_personal, task_all_topics, task_can_write, task_can_upload, grant_id
  ) values (
    auth.uid(), p_client_id, btrim(p_label), p_personal, p_all_topics, memory_ids, p_can_write,
    p_task_personal, p_task_all_topics, p_task_can_write, p_task_can_upload, next_grant
  )
  on conflict(owner_id, client_id) do update set
    label = excluded.label,
    personal = excluded.personal,
    all_topics = excluded.all_topics,
    topic_ids = excluded.topic_ids,
    can_write = excluded.can_write,
    task_personal = excluded.task_personal,
    task_all_topics = excluded.task_all_topics,
    task_can_write = excluded.task_can_write,
    task_can_upload = excluded.task_can_upload,
    revoked_at = null,
    grant_id = excluded.grant_id;

  -- Rewritten on every authorization, so a grant never keeps rows from the
  -- previous one. A blanket task grant writes none at all.
  delete from public.agent_task_grants
    where owner_id = auth.uid() and client_id = p_client_id;
  insert into public.agent_task_grants(
    owner_id, client_id, grant_id, topic_id, can_read, can_write, can_upload
  )
  select auth.uid(), p_client_id, next_grant, topic_id, true,
    p_task_can_write, p_task_can_upload
  from (select distinct unnest(task_ids) topic_id) selected;
end;
$function$;

CREATE OR REPLACE FUNCTION public.capture_memory(p_id uuid, p_statement text, p_source text, p_topic_slug text DEFAULT NULL::text, p_kind text DEFAULT 'fact'::text, p_trace text DEFAULT NULL::text, p_document uuid DEFAULT NULL::uuid, p_expires timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS memories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  caller uuid := auth.uid();
  target_topic uuid;
  result public.memories;
begin
  perform private.attribute(p_trace, p_document, null);
  if p_topic_slug is not null then
    select id into target_topic from public.topics
      where owner_id = caller and slug = p_topic_slug;
  end if;
  insert into public.memories(id, topic_id, statement, source, band, kind, expires_at)
    values(p_id, target_topic, btrim(p_statement), p_source, 'heard', p_kind,
           -- An expiry already in the past is a mistake, not an instruction to
           -- write something invisible. Dropped, so the memory is at least
           -- readable and deletable.
           case when p_expires > now() then p_expires end)
    on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  if result.id is null
    or result.statement is distinct from btrim(p_statement)
    or result.kind is distinct from p_kind then
    raise exception 'Memory request conflict' using errcode = 'PT409', hint = 'satchel:conflict:memory_request';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_memory(p_id uuid, p_revision integer)
 RETURNS memories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.memories;
begin
  update public.memories set band = 'said', affirmed_at = now()
    where id = p_id and revision = p_revision returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:memory';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.correct_memory(p_id uuid, p_revision integer, p_statement text, p_name text DEFAULT NULL::text, p_more_info text DEFAULT ''::text)
 RETURNS memories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.memories;
begin
  update public.memories
    set statement = btrim(p_statement),
        name = nullif(btrim(coalesce(p_name, '')), ''),
        more_info = p_more_info,
        band = 'said',
        affirmed_at = now()
    where id = p_id and revision = p_revision
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:memory';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_task(p_request_id uuid, p_id uuid, p_topic_id uuid, p_title text, p_outcome text DEFAULT ''::text, p_why text DEFAULT ''::text, p_done_when text[] DEFAULT '{}'::text[], p_next_action text DEFAULT ''::text, p_priority text DEFAULT 'medium'::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result public.tasks;
  previous public.task_write_requests;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'topic_id', p_topic_id, 'title', btrim(p_title),
    'outcome', p_outcome, 'why', p_why, 'done_when', p_done_when,
    'next_action', p_next_action, 'priority', p_priority
  )::text);
begin
  if not private.task_can_access(p_topic_id, 'write') then
    raise exception 'Task write unavailable' using errcode = '42501', hint = 'satchel:refused:task_write';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'create_task' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into result from public.tasks
      where owner_id = auth.uid() and id = previous.task_id;
    return result;
  end if;

  insert into public.tasks(
    owner_id, topic_id, id, title, outcome, why, done_when,
    next_action, priority, created_by, updated_by
  ) values (
    auth.uid(), p_topic_id, p_id, btrim(p_title), p_outcome, p_why,
    p_done_when, p_next_action, p_priority, actor, actor
  ) returning * into result;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, to_revision, details, created_by
  ) values (
    auth.uid(), p_topic_id, p_id, 'created', result.revision,
    jsonb_build_object('status', result.status, 'priority', result.priority), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, result_revision
  ) values (auth.uid(), p_request_id, 'create_task', payload_hash, p_id, result.revision);
  return result;
exception when unique_violation then
  raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_topic(p_id uuid, p_name text, p_brief text, p_slug text DEFAULT NULL::text)
 RETURNS topics
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.topics;
begin
  insert into public.topics(id, name, brief) values(p_id, btrim(p_name), btrim(p_brief)) on conflict(id) do nothing;
  select * into result from public.topics where id = p_id;
  if result.id is null or result.name is distinct from btrim(p_name) or result.brief is distinct from btrim(p_brief) then
    raise exception 'Topic request conflict' using errcode = 'PT409', hint = 'satchel:conflict:topic_request';
  end if;
  if nullif(btrim(p_slug), '') is not null and btrim(p_slug) <> result.slug then
    perform public.set_slug('topic', p_id, btrim(p_slug));
    select * into result from public.topics where id = p_id;
  end if;
  return result;
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
    raise exception 'Task not found' using errcode = 'P0002', hint = 'satchel:gone:task';
  end if;
  if target.revision <> p_expected_revision then
    raise exception 'Task revision conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_revision';
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
    raise exception 'Topic not found' using errcode = 'P0002', hint = 'satchel:gone:topic';
  end if;
  if target.revision <> p_expected_revision then
    raise exception 'Topic revision conflict' using errcode = 'PT409', hint = 'satchel:conflict:topic_revision';
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

CREATE OR REPLACE FUNCTION public.enable_consolidation(p_client_id text, p_refresh_token text, p_endpoint text, p_idle_minutes integer DEFAULT 30, p_days smallint[] DEFAULT NULL::smallint[], p_times time without time zone[] DEFAULT NULL::time without time zone[], p_timezone text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := private.require_companion();
  name text;
  existing uuid;
  secret uuid;
  -- Only a missing argument takes the default. An empty list is a choice, and
  -- set_consolidation_schedule refuses it, so this must too.
  chosen_days smallint[] := case when p_days is null then array[0,1,2,3,4,5,6]::smallint[]
                                 else private.clean_days(p_days) end;
  chosen_times time[] := case when p_times is null then array['02:00'::time]
                              else private.clean_times(p_times) end;
  chosen_zone text := coalesce(p_timezone, 'UTC');
  problem text;
begin
  if coalesce(btrim(p_refresh_token), '') = '' then
    raise exception 'A refresh token is required' using errcode = '22023', hint = 'satchel:invalid:refresh_token';
  end if;
  -- This is where the stored refresh token gets posted, so the browser does
  -- not get to name any URL it likes. Hosted, over https, and the one path.
  -- A localhost address could never be reached from the database anyway.
  if p_endpoint is null or p_endpoint !~ '^https://[^\s/?#@]+/api/consolidate$' then
    raise exception 'The overnight pass can only call this deployment over https.' using errcode = '22023', hint = 'satchel:invalid:overnight_https';
  end if;
  problem := private.schedule_problem(chosen_days, chosen_times, chosen_zone);
  if problem is not null then raise exception '%', problem using errcode = '22023', hint = 'satchel:person'; end if;
  name := 'satchel_consolidation:' || caller::text;
  select c.secret_id into existing from public.consolidation_credentials c where c.owner_id = caller;
  if existing is not null then
    perform vault.update_secret(existing, p_refresh_token, name,
      'Satchel background consolidation, refreshed on every run');
    secret := existing;
  else
    secret := vault.create_secret(p_refresh_token, name,
      'Satchel background consolidation, refreshed on every run');
  end if;
  insert into public.consolidation_credentials(owner_id, client_id, secret_id, endpoint, idle_minutes,
      days, times, timezone)
    values (caller, p_client_id, secret, p_endpoint, coalesce(p_idle_minutes, 30),
      chosen_days, chosen_times, chosen_zone)
    on conflict (owner_id) do update
      set client_id = excluded.client_id, secret_id = excluded.secret_id,
          endpoint = excluded.endpoint, idle_minutes = excluded.idle_minutes,
          days = excluded.days, times = excluded.times, timezone = excluded.timezone,
          enabled = true, failures = 0, last_error = null,
          -- A refusal from before the person signed in again is not about
          -- this credential, and must not count against it.
          last_request_id = null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.end_memory(p_id uuid, p_revision integer, p_reason text, p_ended_by uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text, p_trace text DEFAULT NULL::text, p_document uuid DEFAULT NULL::uuid)
 RETURNS memories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.memories;
begin
  perform private.attribute(p_trace, p_document, p_note);
  update public.memories
    set ended_at = now(), ended_reason = p_reason,
        ended_by = case when p_reason = 'replaced' then p_ended_by else null end,
        ended_note = left(p_note, 500)
    where id = p_id and revision = p_revision and ended_at is null
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:memory';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.extend_memory(p_id uuid, p_revision integer, p_statement text, p_trace text DEFAULT NULL::text, p_document uuid DEFAULT NULL::uuid)
 RETURNS memories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.memories;
begin
  perform private.attribute(p_trace, p_document, null);
  perform set_config('satchel.change', 'extended', true);
  update public.memories
    set statement = btrim(p_statement), affirmed_at = now(), mentions = mentions + 1, band = 'said'
    where id = p_id and revision = p_revision and ended_at is null
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:memory';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fail_task_file(p_request_id uuid, p_resource_id uuid, p_reason text)
 RETURNS task_resources
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  resource_result public.task_resources;
  previous public.task_write_requests;
  payload_hash text := md5(jsonb_build_object(
    'resource_id', p_resource_id, 'reason', left(btrim(p_reason), 500)
  )::text);
begin
  select * into resource_result from public.task_resources
    where owner_id = auth.uid() and id = p_resource_id;
  if resource_result.id is null
    or not private.task_can_access(resource_result.topic_id, 'upload') then
    raise exception 'Task upload unavailable' using errcode = '42501', hint = 'satchel:refused:task_upload';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'fail_task_file' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    return resource_result;
  end if;
  if resource_result.kind <> 'storage_object' or resource_result.upload_status <> 'pending' then
    raise exception 'Upload is not pending' using errcode = 'PT409', hint = 'satchel:conflict:upload';
  end if;
  update public.task_resources set upload_status = 'failed', failure_reason = left(btrim(p_reason), 500)
    where owner_id = auth.uid() and id = p_resource_id
    returning * into resource_result;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, to_revision, details, created_by
  ) values (
    resource_result.owner_id, resource_result.topic_id, resource_result.task_id,
    'resource_upload_failed',
    (select revision from public.tasks where owner_id = resource_result.owner_id and id = resource_result.task_id),
    jsonb_build_object('resource_id', p_resource_id, 'reason', resource_result.failure_reason),
    private.task_actor()
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'fail_task_file', payload_hash,
    resource_result.task_id, resource_result.id,
    (select revision from public.tasks where owner_id = auth.uid() and id = resource_result.task_id)
  );
  return resource_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_task_file(p_request_id uuid, p_resource_id uuid)
 RETURNS task_resources
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  resource_result public.task_resources;
  previous public.task_write_requests;
  actual_bytes bigint;
  actual_checksum text;
  payload_hash text := md5(jsonb_build_object('resource_id', p_resource_id)::text);
begin
  select * into resource_result from public.task_resources
    where owner_id = auth.uid() and id = p_resource_id;
  if resource_result.id is null
    or not private.task_can_access(resource_result.topic_id, 'upload') then
    raise exception 'Task upload unavailable' using errcode = '42501', hint = 'satchel:refused:task_upload';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'finalize_task_file' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    return resource_result;
  end if;
  if resource_result.kind <> 'storage_object' or resource_result.upload_status <> 'pending' then
    raise exception 'Upload is not pending' using errcode = 'PT409', hint = 'satchel:conflict:upload';
  end if;

  execute $query$
    select coalesce((metadata->>'size')::bigint, 0), lower(user_metadata->>'sha256')
    from storage.objects
    where bucket_id = 'task-files' and name = $1
  $query$ into actual_bytes, actual_checksum using resource_result.object_key;
  if actual_bytes is distinct from resource_result.expected_bytes
    or actual_checksum is distinct from resource_result.checksum_sha256 then
    update public.task_resources set
      upload_status = 'failed', failure_reason = 'size_or_checksum_mismatch'
      where owner_id = auth.uid() and id = p_resource_id
      returning * into resource_result;
    insert into public.task_events(
      owner_id, topic_id, task_id, event_type, to_revision, details, created_by
    ) values (
      resource_result.owner_id, resource_result.topic_id, resource_result.task_id,
      'resource_upload_failed',
      (select revision from public.tasks where owner_id = resource_result.owner_id and id = resource_result.task_id),
      jsonb_build_object('resource_id', p_resource_id, 'reason', resource_result.failure_reason),
      private.task_actor()
    );
    insert into public.task_write_requests(
      owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
    ) values (
      auth.uid(), p_request_id, 'finalize_task_file', payload_hash,
      resource_result.task_id, resource_result.id,
      (select revision from public.tasks where owner_id = auth.uid() and id = resource_result.task_id)
    );
    return resource_result;
  end if;
  update public.task_resources set
    upload_status = 'verified', verified_at = clock_timestamp(), failure_reason = null
    where owner_id = auth.uid() and id = p_resource_id
    returning * into resource_result;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, to_revision, details, created_by
  ) values (
    resource_result.owner_id, resource_result.topic_id, resource_result.task_id,
    'resource_upload_verified',
    (select revision from public.tasks where owner_id = resource_result.owner_id and id = resource_result.task_id),
    jsonb_build_object('resource_id', p_resource_id, 'bytes', actual_bytes),
    private.task_actor()
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'finalize_task_file', payload_hash,
    resource_result.task_id, resource_result.id,
    (select revision from public.tasks where owner_id = auth.uid() and id = resource_result.task_id)
  );
  return resource_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.link_topic_repository(p_topic_id uuid, p_provider text, p_repository text)
 RETURNS topic_repositories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.topic_repositories;
begin
  insert into public.topic_repositories(topic_id, provider, repository)
    values(p_topic_id, lower(btrim(p_provider)), lower(btrim(p_repository)))
    on conflict(owner_id, provider, repository, topic_id) do nothing;
  select * into result from public.topic_repositories
    where owner_id = auth.uid() and topic_id = p_topic_id
      and provider = lower(btrim(p_provider))
      and repository = lower(btrim(p_repository));
  if result.topic_id is null then
    raise exception 'Repository link unavailable' using errcode = '42501', hint = 'satchel:refused:repository_link';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_document_consolidated(p_document_id uuid, p_through bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  update public.documents
    set consolidated_at = now(),
        consolidated_through = greatest(coalesce(consolidated_through, 0), coalesce(p_through, 0))
    where owner_id = caller and id = p_document_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_session_classified(p_session_key text, p_through bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid := auth.uid(); marked integer;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  update public.session_messages m set classified_at = now()
    where m.owner_id = caller and m.session_key = p_session_key
      and m.id <= p_through and m.classified_at is null;
  get diagnostics marked = row_count;
  return marked;
end;
$function$;

CREATE OR REPLACE FUNCTION public.merge_topic(p_from uuid, p_into uuid, p_note text DEFAULT NULL::text, p_trace text DEFAULT NULL::text)
 RETURNS topic_merges
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  source public.topics;
  target public.topics;
  moved uuid[];
  merge public.topic_merges;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session';
  end if;
  select * into source from public.topics where id = p_from and owner_id = auth.uid() for update;
  select * into target from public.topics where id = p_into and owner_id = auth.uid();
  if source.id is null or target.id is null or source.id = target.id
    or source.merged_into is not null or target.merged_into is not null then
    raise exception 'Topic changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:topic';
  end if;
  if not private.may_write_scope(source.id) or not private.may_write_scope(target.id) then
    raise exception 'Topic write unavailable' using errcode = '42501', hint = 'satchel:refused:topic_write';
  end if;
  if auth.jwt()->>'client_id' is not null and source.made_by <> 'satchel' then
    raise exception 'Topic has tasks or repositories' using errcode = '23514', hint = 'satchel:invalid:topic_has_work';
  end if;
  if exists (select 1 from public.tasks where topic_id = source.id)
    or exists (select 1 from public.topic_repositories where topic_id = source.id) then
    raise exception 'Topic has tasks or repositories' using errcode = '23514', hint = 'satchel:invalid:topic_has_work';
  end if;
  with shifted as (
    update public.memories set topic_id = target.id
      where topic_id = source.id and owner_id = auth.uid() and ended_at is null
      returning id, owner_id
  ), logged as (
    insert into public.memory_events(owner_id, memory_id, action, before, after, actor, reason, trace_id)
      select owner_id, id, 'moved', source.slug, target.slug, private.memory_actor(),
             left(coalesce(p_note, 'merged into ' || target.slug), 500), left(p_trace, 200)
      from shifted
      returning memory_id
  )
  select coalesce(array_agg(memory_id), '{}') into moved from logged;
  update public.topics set merged_into = target.id where id = source.id;
  insert into public.topic_merges(owner_id, from_id, into_id, memory_ids, actor, reason)
    values (auth.uid(), source.id, target.id, moved, private.memory_actor(), left(p_note, 500))
    returning * into merge;
  return merge;
end;
$function$;

CREATE OR REPLACE FUNCTION public.move_memory(p_id uuid, p_revision integer, p_topic_id uuid, p_note text DEFAULT NULL::text, p_trace text DEFAULT NULL::text, p_document uuid DEFAULT NULL::uuid)
 RETURNS memories
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current public.memories;
  result public.memories;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session';
  end if;
  select * into current from public.memories
    where id = p_id and owner_id = auth.uid() and revision = p_revision and ended_at is null
    for update;
  if current.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:memory';
  end if;
  if not private.may_write_scope(current.topic_id) or not private.may_write_scope(p_topic_id) then
    raise exception 'Memory write unavailable' using errcode = '42501', hint = 'satchel:refused:memory_write';
  end if;
  if p_topic_id is not null and exists (select 1 from public.topics
      where id = p_topic_id and merged_into is not null) then
    raise exception 'Topic was merged' using errcode = '23514', hint = 'satchel:invalid:topic_merged';
  end if;
  if current.topic_id is not distinct from p_topic_id then return current; end if;
  update public.memories set topic_id = p_topic_id where id = p_id returning * into result;
  insert into public.memory_events(owner_id, memory_id, action, before, after, actor, reason, trace_id, document_id)
    values (current.owner_id, p_id, 'moved', private.scope_name(current.topic_id),
            private.scope_name(p_topic_id), private.memory_actor(), left(p_note, 500),
            left(p_trace, 200), p_document);
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.note_document_repository(p_session_key text, p_repository text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := auth.uid();
  repo text := lower(btrim(coalesce(p_repository, '')));
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  if length(repo) > 201 or repo !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' then return; end if;
  update public.documents set repository = repo
    where owner_id = caller and session_key = p_session_key
      and repository is distinct from repo;
end;
$function$;

CREATE OR REPLACE FUNCTION public.read_memory(p_topic_id uuid, p_id uuid)
 RETURNS memories
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare result public.memories;
begin
  select * into result from public.memories
    where topic_id is not distinct from p_topic_id and id = p_id;
  if result.id is null then
    raise exception 'Memory not found or unavailable' using errcode = 'P0002', hint = 'satchel:gone:memory';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.recent_documents(p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, session_key text, topic_id uuid, topic_slug text, turns integer, chars integer, started_at timestamp with time zone, last_turn_at timestamp with time zone, consolidated_at timestamp with time zone, consolidated_through bigint, truncated_at timestamp with time zone, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'Your conversations are readable from your own session only' using errcode = '42501', hint = 'satchel:session';
  end if;
  if ((select auth.jwt())->>'client_id') is not null then
    raise exception 'Your conversations are readable from your own session only' using errcode = '42501', hint = 'satchel:app_token';
  end if;
  return query
    select d.id, d.session_key, d.topic_id, p.slug, d.turns, d.chars,
           d.started_at, d.last_turn_at, d.consolidated_at, d.consolidated_through,
           d.truncated_at, d.expires_at
    from public.documents d
    left join public.topics p on p.id = d.topic_id
    where d.owner_id = caller
      -- Inclusive, and the caller drops what it has already seen. The cursor
      -- is a moment rather than a row, and two sources can land on the same
      -- microsecond; excluding the boundary would silently skip whichever one
      -- did not make the previous page.
      and (p_before is null or d.last_turn_at <= p_before)
    order by d.last_turn_at desc
    limit greatest(coalesce(p_limit, 50), 1);
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_document_turn(p_session_key text, p_role text, p_content text, p_topic_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := auth.uid();
  doc public.documents;
  body text := btrim(left(coalesce(p_content, ''), 8000));
  -- About 100k tokens of conversation. Past this the session stops being
  -- recorded rather than growing without a limit.
  cap constant integer := 400000;
  scope uuid := p_topic_id;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  -- A topic the caller does not own is a mistake, not a scope. Dropping it
  -- keeps the document personal, which is the harmless direction: a personal
  -- document is visible to its owner, and a wrongly scoped one is not.
  if scope is not null and not exists (
    select 1 from public.topics p where p.id = scope and p.owner_id = caller)
  then scope := null; end if;

  insert into public.documents as d (owner_id, session_key, topic_id)
    values (caller, p_session_key, scope)
    on conflict (owner_id, session_key) do update
      set topic_id = coalesce(excluded.topic_id, d.topic_id)
    returning * into doc;

  if body = '' then return doc.id; end if;
  if doc.chars + length(body) > cap then
    update public.documents set truncated_at = coalesce(truncated_at, now()) where id = doc.id;
    return doc.id;
  end if;

  insert into public.document_turns(document_id, owner_id, role, content)
    values (doc.id, caller, p_role, body);
  update public.documents
    set turns = turns + 1, chars = chars + length(body), last_turn_at = now()
    where id = doc.id;
  return doc.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_repository_head(p_provider text, p_repository text, p_commits integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  if p_commits is null or p_commits < 0 then return; end if;
  insert into public.repository_heads as h (owner_id, provider, repository, commits)
    values (caller, p_provider, lower(p_repository), p_commits)
    on conflict (owner_id, provider, repository) do update
      set commits = greatest(h.commits, excluded.commits),
          seen_at = now()
      where excluded.commits >= h.commits;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_session_message(p_session_key text, p_role text, p_content text, p_keep integer DEFAULT 12)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  if coalesce(btrim(p_content), '') = '' then return; end if;
  insert into public.session_messages(owner_id, session_key, role, content)
    values (caller, p_session_key, p_role, left(p_content, 8000));
  -- Trim as we go: the window is short by design and an unbounded log of
  -- conversation is exactly what this design exists not to keep.
  delete from public.session_messages m
    where m.owner_id = caller and m.session_key = p_session_key
      and m.id not in (
        select id from public.session_messages
        where owner_id = caller and session_key = p_session_key
        order by id desc limit greatest(p_keep, 1));
  delete from public.session_messages where created_at < now() - interval '24 hours';
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_task_handoff(p_request_id uuid, p_id uuid, p_task_id uuid, p_expected_revision bigint, p_supersedes_ids uuid[], p_completed text[], p_decisions text[], p_validation jsonb, p_remaining text[], p_blockers text[], p_next_action text, p_summary text DEFAULT ''::text, p_status text DEFAULT NULL::text, p_blocked_reason text DEFAULT ''::text, p_resource_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  task_result public.tasks;
  handoff_result public.task_handoffs;
  previous public.task_write_requests;
  current_topic uuid;
  old_status text;
  old_reason text;
  actor text := private.task_actor();
  next_status text;
  next_reason text;
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'supersedes_ids', p_supersedes_ids, 'completed', p_completed, 'decisions', p_decisions,
    'validation', p_validation, 'remaining', p_remaining, 'blockers', p_blockers,
    'next_action', p_next_action, 'summary', p_summary, 'status', p_status,
    'blocked_reason', p_blocked_reason, 'resource_ids', p_resource_ids
  )::text);
begin
  select topic_id, status, blocked_reason into current_topic, old_status, old_reason from public.tasks
    where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_topic, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'record_task_handoff' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into task_result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    select * into handoff_result from public.task_handoffs where owner_id = auth.uid() and id = previous.handoff_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'handoff', to_jsonb(handoff_result));
  end if;
  if array_position(p_supersedes_ids, p_id) is not null
    or (select count(*) from unnest(p_supersedes_ids) value)
      <> (select count(distinct value) from unnest(p_supersedes_ids) value)
    or exists (
      select 1 from unnest(p_supersedes_ids) value
      where not exists (
        select 1 from public.task_handoffs h
        where h.owner_id = auth.uid() and h.topic_id is not distinct from current_topic
          and h.task_id = p_task_id and h.id = value
      )
    ) then
    raise exception 'Invalid handoff supersession' using errcode = '23514', hint = 'satchel:fault:handoff';
  end if;
  if array_position(p_resource_ids, null) is not null
    or exists (
      select 1 from unnest(p_resource_ids) value
      where not exists (
        select 1 from public.task_resources r
        where r.owner_id = auth.uid() and r.topic_id is not distinct from current_topic
          and r.task_id = p_task_id and r.id = value and r.upload_status = 'verified'
      )
    ) then
    raise exception 'Invalid handoff resource' using errcode = '23514', hint = 'satchel:invalid:task_resource';
  end if;

  next_status := coalesce(p_status, old_status);
  next_reason := case
    when next_status <> 'blocked' then ''
    when p_status is null then old_reason
    else btrim(p_blocked_reason)
  end;
  update public.tasks set
    next_action = p_next_action,
    status = next_status,
    blocked_reason = next_reason,
    closed_at = case when next_status = 'done' then clock_timestamp() else null end,
    revision = revision + 1,
    updated_by = actor,
    updated_at = clock_timestamp()
  where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
  returning * into task_result;
  if task_result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;

  insert into public.task_handoffs(
    owner_id, topic_id, task_id, id, supersedes_ids, completed, decisions,
    validation, remaining, blockers, next_action, summary, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, p_id, p_supersedes_ids, p_completed,
    p_decisions, p_validation, p_remaining, p_blockers, p_next_action, p_summary, actor
  ) returning * into handoff_result;
  insert into public.handoff_resource_refs(owner_id, topic_id, task_id, handoff_id, resource_id)
    select auth.uid(), current_topic, p_task_id, p_id, value
    from (select distinct unnest(p_resource_ids) value) selected;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, 'handoff_recorded',
    p_expected_revision, task_result.revision,
    jsonb_build_object('handoff_id', p_id, 'status_from', old_status, 'status_to', next_status), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, handoff_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'record_task_handoff', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'handoff', to_jsonb(handoff_result));
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_task_progress(p_request_id uuid, p_id uuid, p_task_id uuid, p_expected_revision bigint, p_summary text, p_completed text[] DEFAULT '{}'::text[], p_decisions text[] DEFAULT '{}'::text[], p_remaining text[] DEFAULT '{}'::text[], p_blockers text[] DEFAULT '{}'::text[], p_next_action text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_blocked_reason text DEFAULT ''::text, p_resource_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  task_result public.tasks;
  update_result public.task_updates;
  previous public.task_write_requests;
  current_topic uuid;
  old_status text;
  old_reason text;
  old_next_action text;
  actor text := private.task_actor();
  next_status text;
  next_reason text;
  resolved_next_action text;
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'summary', p_summary, 'completed', p_completed, 'decisions', p_decisions,
    'remaining', p_remaining, 'blockers', p_blockers, 'next_action', p_next_action,
    'status', p_status, 'blocked_reason', p_blocked_reason, 'resource_ids', p_resource_ids
  )::text);
begin
  select topic_id, status, blocked_reason, next_action
    into current_topic, old_status, old_reason, old_next_action
    from public.tasks where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_topic, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;

  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'record_task_progress' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into task_result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    select * into update_result from public.task_updates where owner_id = auth.uid() and id = previous.update_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'update', to_jsonb(update_result));
  end if;

  if p_completed is null or p_decisions is null or p_remaining is null or p_blockers is null
    or p_resource_ids is null
    or array_position(p_resource_ids, null) is not null
    or (select count(*) from unnest(p_resource_ids) value)
      <> (select count(distinct value) from unnest(p_resource_ids) value)
    or exists (
      select 1 from unnest(p_resource_ids) value
      where not exists (
        select 1 from public.task_resources r
        where r.owner_id = auth.uid()
          and r.topic_id is not distinct from current_topic
          and r.task_id = p_task_id and r.id = value and r.upload_status = 'verified'
      )
    ) then
    raise exception 'Invalid progress update' using errcode = '23514', hint = 'satchel:invalid:task_resource';
  end if;

  next_status := coalesce(p_status, old_status);
  if next_status not in ('inbox', 'ready', 'in_progress', 'blocked', 'done') then
    raise exception 'Invalid task state' using errcode = '23514', hint = 'satchel:invalid:task_state';
  end if;
  next_reason := case
    when next_status <> 'blocked' then ''
    when p_status is null then old_reason
    else btrim(p_blocked_reason)
  end;
  if next_status = 'blocked' and length(btrim(next_reason)) = 0 then
    raise exception 'Blocked tasks require a reason' using errcode = '23514', hint = 'satchel:invalid:blocked_reason';
  end if;
  resolved_next_action := coalesce(p_next_action, old_next_action);

  update public.tasks set
    next_action = resolved_next_action,
    status = next_status,
    blocked_reason = next_reason,
    closed_at = case when next_status = 'done' then clock_timestamp() else null end,
    revision = revision + 1,
    updated_by = actor,
    updated_at = clock_timestamp()
  where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
  returning * into task_result;
  if task_result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;

  insert into public.task_updates(
    owner_id, topic_id, task_id, id, kind, body, completed, decisions,
    remaining, blockers, next_action, status, blocked_reason, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, p_id, 'progress', btrim(p_summary),
    p_completed, p_decisions, p_remaining, p_blockers,
    task_result.next_action, task_result.status, task_result.blocked_reason, actor
  ) returning * into update_result;

  insert into public.task_update_resource_refs(
    owner_id, topic_id, task_id, update_id, resource_id
  ) select auth.uid(), current_topic, p_task_id, p_id, value
    from unnest(p_resource_ids) value;

  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, 'progress_recorded',
    p_expected_revision, task_result.revision,
    jsonb_build_object(
      'update_id', p_id, 'status_from', old_status, 'status_to', next_status,
      'resource_count', cardinality(p_resource_ids)
    ), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, update_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'record_task_progress', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'update', to_jsonb(update_result));
end;
$function$;

CREATE OR REPLACE FUNCTION public.remove_task_dependency(p_request_id uuid, p_task_id uuid, p_expected_revision bigint, p_depends_on_task_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  task_result public.tasks;
  previous public.task_write_requests;
  current_topic uuid;
  current_scope text;
  removed_id uuid;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'depends_on_task_id', p_depends_on_task_id
  )::text);
begin
  select topic_id, scope_key into current_topic, current_scope
    from public.tasks where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_topic, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'remove_task_dependency' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into task_result from public.tasks
      where owner_id = auth.uid() and id = previous.task_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'removed_task_id', previous.related_task_id);
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text), hashtext(current_scope));
  select * into task_result from public.tasks
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    for update;
  if not found then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;

  delete from public.task_dependencies
    where owner_id = auth.uid() and task_id = p_task_id
      and depends_on_task_id = p_depends_on_task_id
    returning depends_on_task_id into removed_id;
  if removed_id is not null then
    update public.tasks set revision = revision + 1, updated_by = actor,
      updated_at = clock_timestamp()
      where owner_id = auth.uid() and id = p_task_id
      returning * into task_result;
    insert into public.task_events(
      owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
    ) values (
      auth.uid(), current_topic, p_task_id, 'dependency_removed',
      p_expected_revision, task_result.revision,
      jsonb_build_object('depends_on_task_id', p_depends_on_task_id), actor
    );
  end if;
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'remove_task_dependency', payload_hash,
    p_task_id, p_depends_on_task_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'removed_task_id', p_depends_on_task_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_task_file(p_request_id uuid, p_id uuid, p_task_id uuid, p_expected_revision bigint, p_label text, p_original_filename text, p_media_type text, p_expected_bytes bigint, p_checksum_sha256 text, p_resource_type text DEFAULT 'document'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  task_result public.tasks;
  resource_result public.task_resources;
  previous public.task_write_requests;
  current_topic uuid;
  actor text := private.task_actor();
  object_key text := auth.uid()::text || '/' || p_task_id::text || '/' || p_id::text;
  normalized_checksum text := lower(p_checksum_sha256);
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'label', btrim(p_label), 'original_filename', p_original_filename,
    'media_type', p_media_type, 'expected_bytes', p_expected_bytes,
    'checksum_sha256', normalized_checksum, 'resource_type', p_resource_type
  )::text);
begin
  select topic_id into current_topic from public.tasks
    where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_topic, 'upload') then
    raise exception 'Task upload unavailable' using errcode = '42501', hint = 'satchel:refused:task_upload';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'reserve_task_file' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into task_result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    select * into resource_result from public.task_resources where owner_id = auth.uid() and id = previous.resource_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'resource', to_jsonb(resource_result));
  end if;

  update public.tasks set revision = revision + 1, updated_by = actor, updated_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    returning * into task_result;
  if task_result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;
  insert into public.task_resources(
    owner_id, topic_id, task_id, id, kind, resource_type, label, object_key,
    original_filename, media_type, expected_bytes, checksum_sha256,
    upload_status, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, p_id, 'storage_object', p_resource_type,
    btrim(p_label), object_key, p_original_filename, p_media_type, p_expected_bytes,
    normalized_checksum, 'pending', actor
  ) returning * into resource_result;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, 'resource_upload_reserved',
    p_expected_revision, task_result.revision,
    jsonb_build_object('resource_id', p_id, 'expected_bytes', p_expected_bytes), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, resource_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'reserve_task_file', payload_hash,
    p_task_id, p_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'resource', to_jsonb(resource_result));
end;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_agent_repository(p_session_key text, p_provider text, p_repository text, p_select boolean DEFAULT true)
 RETURNS TABLE(topic_id uuid, slug text, name text, brief text, selected boolean)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  candidates uuid[];
  chosen uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session';
  end if;
  select array_agg(r.topic_id) into candidates
    from public.topic_repositories r
    join public.topics p on p.id = r.topic_id and p.owner_id = r.owner_id
    where r.owner_id = auth.uid()
      and r.provider = lower(btrim(p_provider))
      and r.repository = lower(btrim(p_repository));
  if candidates is null then return; end if;
  -- One candidate still activates with no model involved and no tool call,
  -- which stays the common case. Several never does: filing a memory in a real
  -- topic that is the wrong topic is worse than leaving it personal, which
  -- is at least visibly unscoped.
  if p_select and array_length(candidates, 1) = 1 then
    chosen := candidates[1];
    perform public.select_agent_topic(p_session_key, chosen);
  end if;
  -- coalesce, not a bare comparison. With nothing chosen, `p.id = chosen` is
  -- null rather than false, so every candidate came back with selected null and
  -- a caller checking `=== false` saw none of them as unselected.
  return query
    select p.id, p.slug, p.name, p.brief, coalesce(p.id = chosen, false)
    from public.topics p
    where p.id = any(candidates)
    order by p.name;
end;
$function$;

CREATE OR REPLACE FUNCTION public.restore_memory(p_id uuid, p_revision integer)
 RETURNS memories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.memories;
begin
  update public.memories
    set ended_at = null, ended_reason = null, ended_by = null, ended_note = null,
        expires_at = case when expires_at <= now() then null else expires_at end,
        affirmed_at = now()
    where id = p_id and revision = p_revision
      and (ended_at is not null or (expires_at is not null and expires_at <= now()))
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:memory';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_agent(p_client_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Companion sign-in required' using errcode = '42501', hint = 'satchel:session';
  end if;
  if auth.jwt()->>'client_id' is not null then
    raise exception 'Companion sign-in required' using errcode = '42501', hint = 'satchel:app_token';
  end if;
  delete from public.agent_task_grants
    where owner_id = auth.uid() and client_id = p_client_id;
  update public.agent_connections
    set revoked_at = now(), grant_id = gen_random_uuid(),
      task_personal = false, task_can_write = false, task_can_upload = false
    where owner_id = auth.uid() and client_id = p_client_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.rotate_consolidation_credential(p_refresh_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid := auth.uid(); target uuid;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  if coalesce(btrim(p_refresh_token), '') = '' then return; end if;
  select secret_id into target from public.consolidation_credentials where owner_id = caller;
  if target is null then return; end if;
  perform vault.update_secret(target, p_refresh_token);
  update public.consolidation_credentials
    set last_run_at = now(), failures = 0, last_error = null where owner_id = caller;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_memory(p_id uuid, p_topic_id uuid, p_statement text, p_source text DEFAULT ''::text, p_band text DEFAULT 'said'::text, p_name text DEFAULT NULL::text, p_more_info text DEFAULT ''::text, p_kind text DEFAULT 'fact'::text)
 RETURNS memories
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result public.memories;
begin
  insert into public.memories(id, topic_id, statement, source, band, name, more_info, kind)
    values(p_id, p_topic_id, btrim(p_statement), p_source, p_band,
           nullif(btrim(coalesce(p_name, '')), ''), p_more_info, p_kind)
    on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  if result.id is null
    or result.topic_id is distinct from p_topic_id
    or result.statement is distinct from btrim(p_statement)
    or result.band is distinct from p_band
    or result.kind is distinct from p_kind then
    raise exception 'Memory request conflict' using errcode = 'PT409', hint = 'satchel:conflict:memory_request';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_task_edit(p_request_id uuid, p_id uuid, p_expected_revision bigint, p_title text DEFAULT NULL::text, p_outcome text DEFAULT NULL::text, p_why text DEFAULT NULL::text, p_done_when text[] DEFAULT NULL::text[], p_next_action text DEFAULT NULL::text, p_priority text DEFAULT NULL::text, p_set_parent boolean DEFAULT false, p_parent_task_id uuid DEFAULT NULL::uuid, p_remove_dependency_ids uuid[] DEFAULT '{}'::uuid[], p_add_dependency_ids uuid[] DEFAULT '{}'::uuid[])
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
  -- derived from the caller's and from the whole edit. The same edit retried
  -- finds its receipts; a different edit under a reused id gets new ones and
  -- meets the revision it no longer matches.
  edit_key text := p_request_id::text || ':' || md5(jsonb_build_object(
    'id', p_id, 'revision', p_expected_revision, 'title', p_title, 'outcome', p_outcome, 'why', p_why,
    'done_when', p_done_when, 'next_action', p_next_action, 'priority', p_priority,
    'set_parent', p_set_parent, 'parent', p_parent_task_id,
    'remove', p_remove_dependency_ids, 'add', p_add_dependency_ids)::text);
  next_request uuid;
  replay boolean;
begin
  -- The steps commit together, so a receipt for the first means the whole save
  -- landed. The first step still runs, as its own replay, and then the task
  -- comes back as it is now. Running the later steps again would send them a
  -- revision they never saw.
  replay := private.task_request_seen(md5(edit_key || ':1')::uuid);
  <<steps>>
  begin
    if p_title is not null then
      step := step + 1;
      next_request := md5(edit_key || ':' || step)::uuid;
      result := public.update_task(next_request, p_id, revision, p_title, p_outcome, p_why, p_done_when, p_next_action, p_priority);
      revision := result.revision;
      exit steps when replay;
    end if;
    if p_set_parent then
      step := step + 1;
      next_request := md5(edit_key || ':' || step)::uuid;
      revision := (public.set_task_parent(next_request, p_id, revision, p_parent_task_id)->'task'->>'revision')::bigint;
      exit steps when replay;
    end if;
    foreach dep in array coalesce(p_remove_dependency_ids, '{}') loop
      step := step + 1;
      next_request := md5(edit_key || ':' || step)::uuid;
      revision := (public.remove_task_dependency(next_request, p_id, revision, dep)->'task'->>'revision')::bigint;
      exit steps when replay;
    end loop;
    foreach dep in array coalesce(p_add_dependency_ids, '{}') loop
      step := step + 1;
      next_request := md5(edit_key || ':' || step)::uuid;
      revision := (public.add_task_dependency(next_request, p_id, revision, dep)->'task'->>'revision')::bigint;
      exit steps when replay;
    end loop;
  end steps;
  select * into result from public.tasks where owner_id = auth.uid() and id = p_id;
  if result.id is null then raise exception 'Task not found' using errcode = 'P0002', hint = 'satchel:gone:task'; end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.select_agent_repository(p_session_key text, p_provider text, p_repository text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare candidates uuid[];
begin
  select array_agg(topic_id) into candidates from public.topic_repositories
    where owner_id = auth.uid() and provider = lower(btrim(p_provider))
      and repository = lower(btrim(p_repository));
  if candidates is null then
    raise exception 'Repository is not linked to an authorized topic' using errcode = 'P0002', hint = 'satchel:gone:repository_topic';
  end if;
  if array_length(candidates, 1) > 1 then
    raise exception 'Repository is linked to % topics in this grant; select by topic_id',
      array_length(candidates, 1) using errcode = 'PT300', hint = 'satchel:invalid:repository_ambiguous';
  end if;
  perform public.select_agent_topic(p_session_key, candidates[1]);
  return candidates[1];
end;
$function$;

CREATE OR REPLACE FUNCTION public.select_agent_topic(p_session_key text, p_topic_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ begin
        if public.agent_connection_status() is null or (p_topic_id is not null and not public.agent_can_access(p_topic_id,false)) then raise exception 'Scope unavailable' using errcode='42501', hint = 'satchel:refused:scope'; end if;
         insert into public.agent_session_scopes(owner_id,client_id,session_key,grant_id,topic_id) values(auth.uid(),auth.jwt()->>'client_id',p_session_key,(auth.jwt()->>'satchel_grant_id')::uuid,p_topic_id) on conflict(owner_id,client_id,session_key) do update set grant_id=excluded.grant_id,topic_id=excluded.topic_id,updated_at=now(); end; $function$;

CREATE OR REPLACE FUNCTION public.set_consolidation_schedule(p_days smallint[], p_times time without time zone[], p_timezone text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := private.require_companion();
  chosen_days smallint[] := private.clean_days(p_days);
  chosen_times time[] := private.clean_times(p_times);
  problem text;
begin
  problem := private.schedule_problem(chosen_days, chosen_times, p_timezone);
  if problem is not null then raise exception '%', problem using errcode = '22023', hint = 'satchel:person'; end if;
  update public.consolidation_credentials
    set days = chosen_days, times = chosen_times, timezone = p_timezone
    where owner_id = caller;
  if not found then
    raise exception 'Switch the overnight pass on first.' using errcode = 'P0002', hint = 'satchel:refused:overnight_off';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_slug(p_kind text, p_id uuid, p_slug text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid := auth.uid(); touched integer;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session'; end if;
  if p_kind not in ('topic', 'task') then
    raise exception 'Unknown slug kind' using errcode = '23514', hint = 'satchel:fault:slug_kind';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) > 40 then
    raise exception 'A slug is lowercase words joined by hyphens, up to 40 characters' using errcode = '23514', hint = 'satchel:invalid:slug_shape';
  end if;
  -- One namespace per person, so the check spans both tables and excludes the
  -- row being renamed, which is what makes renaming to the current slug a
  -- no-op rather than a conflict.
  if exists (
    select 1 from public.topics p
      where p.owner_id = caller and p.slug = p_slug and (p_kind <> 'topic' or p.id <> p_id)
    union all
    select 1 from public.tasks t
      where t.owner_id = caller and t.slug = p_slug and (p_kind <> 'task' or t.id <> p_id)
  ) then
    raise exception 'That slug is already in use' using errcode = '23505', hint = 'satchel:invalid:slug_taken';
  end if;
  if p_kind = 'topic' then
    update public.topics set slug = p_slug where owner_id = caller and id = p_id;
  else
    update public.tasks set slug = p_slug where owner_id = caller and id = p_id;
  end if;
  get diagnostics touched = row_count;
  if touched = 0 then raise exception 'Record not found' using errcode = 'P0002', hint = 'satchel:gone:record'; end if;
  return p_slug;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_task_parent(p_request_id uuid, p_task_id uuid, p_expected_revision bigint, p_parent_task_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  task_result public.tasks;
  previous public.task_write_requests;
  current_topic uuid;
  current_scope text;
  old_parent_id uuid;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'task_id', p_task_id, 'expected_revision', p_expected_revision,
    'parent_task_id', p_parent_task_id
  )::text);
begin
  select topic_id, scope_key into current_topic, current_scope
    from public.tasks where owner_id = auth.uid() and id = p_task_id;
  if not found or not private.task_can_access(current_topic, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;

  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'set_task_parent' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into task_result from public.tasks
      where owner_id = auth.uid() and id = previous.task_id;
    return jsonb_build_object('task', to_jsonb(task_result), 'parent_id', previous.related_task_id);
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text), hashtext(current_scope));
  select * into task_result from public.tasks
    where owner_id = auth.uid() and id = p_task_id and revision = p_expected_revision
    for update;
  if not found then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;

  if p_parent_task_id = p_task_id then
    raise exception 'A task cannot parent itself' using errcode = '23514', hint = 'satchel:invalid:parent_self';
  end if;
  if p_parent_task_id is not null and not exists (
    select 1 from public.tasks candidate
    where candidate.owner_id = auth.uid() and candidate.scope_key = current_scope
      and candidate.id = p_parent_task_id
  ) then
    raise exception 'Parent task unavailable in this scope' using errcode = '23514', hint = 'satchel:invalid:parent_scope';
  end if;
  if p_parent_task_id is not null and exists (
    with recursive ancestors(id) as (
      select p_parent_task_id
      union all
      select edge.parent_task_id
      from public.task_parent_edges edge
      join ancestors on edge.child_task_id = ancestors.id
      where edge.owner_id = auth.uid() and edge.scope_key = current_scope
    )
    select 1 from ancestors where id = p_task_id
  ) then
    raise exception 'Task parent cycle' using errcode = '23514', hint = 'satchel:invalid:parent_cycle';
  end if;

  select parent_task_id into old_parent_id from public.task_parent_edges
    where owner_id = auth.uid() and child_task_id = p_task_id;
  if old_parent_id is not distinct from p_parent_task_id then
    insert into public.task_write_requests(
      owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
    ) values (
      auth.uid(), p_request_id, 'set_task_parent', payload_hash,
      p_task_id, p_parent_task_id, task_result.revision
    );
    return jsonb_build_object('task', to_jsonb(task_result), 'parent_id', p_parent_task_id);
  end if;

  delete from public.task_parent_edges
    where owner_id = auth.uid() and child_task_id = p_task_id;
  if p_parent_task_id is not null then
    insert into public.task_parent_edges(
      owner_id, topic_id, child_task_id, parent_task_id, created_by
    ) values (auth.uid(), current_topic, p_task_id, p_parent_task_id, actor);
  end if;

  update public.tasks set revision = revision + 1, updated_by = actor,
    updated_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_task_id
    returning * into task_result;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), current_topic, p_task_id, 'parent_changed',
    p_expected_revision, task_result.revision,
    jsonb_build_object('from', old_parent_id, 'to', p_parent_task_id), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, related_task_id, result_revision
  ) values (
    auth.uid(), p_request_id, 'set_task_parent', payload_hash,
    p_task_id, p_parent_task_id, task_result.revision
  );
  return jsonb_build_object('task', to_jsonb(task_result), 'parent_id', p_parent_task_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.stage_agent_repository_hint(p_session_key text, p_provider text, p_repository text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_session_key is null
    or length(p_session_key) not between 16 and 200
    or p_session_key !~ '^[A-Za-z0-9_-]+$'
    or lower(btrim(p_provider)) <> 'github'
    or lower(btrim(p_repository)) !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
    or length(btrim(p_repository)) > 201 then
    raise exception 'Invalid repository hint' using errcode = '22023', hint = 'satchel:invalid:repository_hint';
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
$function$;

CREATE OR REPLACE FUNCTION public.transition_task(p_request_id uuid, p_id uuid, p_expected_revision bigint, p_status text, p_blocked_reason text DEFAULT ''::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result public.tasks;
  previous public.task_write_requests;
  current_topic uuid;
  old_status text;
  actor text := private.task_actor();
  normalized_reason text := case when p_status = 'blocked' then btrim(p_blocked_reason) else '' end;
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'expected_revision', p_expected_revision,
    'status', p_status, 'blocked_reason', normalized_reason
  )::text);
begin
  select topic_id, status into current_topic, old_status from public.tasks
    where owner_id = auth.uid() and id = p_id;
  if not found or not private.task_can_access(current_topic, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'transition_task' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    return result;
  end if;

  update public.tasks set
    status = p_status,
    blocked_reason = normalized_reason,
    closed_at = case when p_status = 'done' then clock_timestamp() else null end,
    revision = revision + 1,
    updated_by = actor,
    updated_at = clock_timestamp()
  where owner_id = auth.uid() and id = p_id and revision = p_expected_revision
  returning * into result;
  if result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), result.topic_id, result.id, 'state_changed',
    p_expected_revision, result.revision,
    jsonb_build_object('from', old_status, 'to', result.status, 'blocked_reason', result.blocked_reason), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, result_revision
  ) values (auth.uid(), p_request_id, 'transition_task', payload_hash, p_id, result.revision);
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.unmerge_topic(p_from uuid)
 RETURNS topic_merges
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  source public.topics;
  merge public.topic_merges;
  into_slug text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session';
  end if;
  select * into source from public.topics where id = p_from and owner_id = auth.uid() for update;
  if source.id is null or source.merged_into is null then
    raise exception 'Topic changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:topic';
  end if;
  if not private.may_write_scope(source.id) or not private.may_write_scope(source.merged_into) then
    raise exception 'Topic write unavailable' using errcode = '42501', hint = 'satchel:refused:topic_write';
  end if;
  select * into merge from public.topic_merges
    where from_id = source.id and owner_id = auth.uid() and undone_at is null
    order by created_at desc limit 1 for update;
  into_slug := private.scope_name(source.merged_into);
  update public.topics set merged_into = null where id = source.id;
  if merge.id is not null then
    with back as (
      update public.memories set topic_id = source.id
        where id = any(merge.memory_ids) and topic_id = merge.into_id
          and owner_id = auth.uid() and ended_at is null
        returning id, owner_id
    )
    insert into public.memory_events(owner_id, memory_id, action, before, after, actor, reason)
      select owner_id, id, 'moved', into_slug, source.slug, private.memory_actor(), 'merge undone'
      from back;
    update public.topic_merges set undone_at = now() where id = merge.id returning * into merge;
  end if;
  return merge;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_task(p_request_id uuid, p_id uuid, p_expected_revision bigint, p_title text, p_outcome text, p_why text, p_done_when text[], p_next_action text, p_priority text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result public.tasks;
  previous public.task_write_requests;
  current_topic uuid;
  actor text := private.task_actor();
  payload_hash text := md5(jsonb_build_object(
    'id', p_id, 'expected_revision', p_expected_revision, 'title', btrim(p_title),
    'outcome', p_outcome, 'why', p_why, 'done_when', p_done_when,
    'next_action', p_next_action, 'priority', p_priority
  )::text);
begin
  select topic_id into current_topic from public.tasks
    where owner_id = auth.uid() and id = p_id;
  if not found or not private.task_can_access(current_topic, 'write') then
    raise exception 'Task unavailable' using errcode = 'P0002', hint = 'satchel:gone:task_moved';
  end if;
  select * into previous from public.task_write_requests
    where owner_id = auth.uid() and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.operation <> 'update_task' or previous.payload_hash <> payload_hash then
      raise exception 'Task request conflict' using errcode = 'PT409', hint = 'satchel:conflict:task_request';
    end if;
    select * into result from public.tasks where owner_id = auth.uid() and id = previous.task_id;
    return result;
  end if;

  update public.tasks set
    title = btrim(p_title), outcome = p_outcome, why = p_why,
    done_when = p_done_when, next_action = p_next_action, priority = p_priority,
    revision = revision + 1, updated_by = actor, updated_at = clock_timestamp()
  where owner_id = auth.uid() and id = p_id and revision = p_expected_revision
  returning * into result;
  if result.id is null then
    raise exception 'Task changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:task';
  end if;
  insert into public.task_events(
    owner_id, topic_id, task_id, event_type, from_revision, to_revision, details, created_by
  ) values (
    auth.uid(), result.topic_id, result.id, 'content_updated',
    p_expected_revision, result.revision,
    jsonb_build_object('priority', result.priority), actor
  );
  insert into public.task_write_requests(
    owner_id, request_id, operation, payload_hash, task_id, result_revision
  ) values (auth.uid(), p_request_id, 'update_task', payload_hash, p_id, result.revision);
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_topic(p_request_id uuid, p_topic_id uuid, p_expected_revision bigint, p_name text, p_brief text, p_repository_action text DEFAULT 'unchanged'::text, p_repository text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := auth.uid();
  client text := auth.jwt()->>'client_id';
  is_agent boolean := client is not null;
  can_manage boolean := false;
  payload_hash text := md5(jsonb_build_object(
    'topic_id', p_topic_id,
    'expected_revision', p_expected_revision,
    'name', btrim(p_name),
    'brief', btrim(p_brief),
    'repository_action', p_repository_action,
    'repository', case when p_repository is null then null else lower(btrim(p_repository)) end
  )::text);
  previous public.topic_write_requests;
  topic public.topics;
  response jsonb;
begin
  if caller is null then
    raise exception 'Authentication required' using errcode = '42501', hint = 'satchel:session';
  end if;

  if is_agent then
    select exists (
      select 1 from public.agent_connections c
      where c.owner_id = caller
        and c.client_id = client
        and c.grant_id::text = auth.jwt()->>'satchel_grant_id'
        and c.revoked_at is null
        and (c.can_write or c.task_can_write)
    ) into can_manage;
  else
    can_manage := true;
  end if;
  if not can_manage then
    raise exception 'Topic write unavailable' using errcode = '42501', hint = 'satchel:refused:topic_write';
  end if;

  if p_repository_action not in ('unchanged', 'link', 'unlink')
    or (p_repository_action = 'unchanged' and p_repository is not null)
    or (p_repository_action in ('link', 'unlink') and (
      p_repository is null
      or lower(btrim(p_repository)) !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
      or length(btrim(p_repository)) > 201
    ))
    or (p_expected_revision is null and p_repository_action = 'unlink') then
    raise exception 'Invalid topic change' using errcode = '23514', hint = 'satchel:fault:topic_change';
  end if;

  select * into previous from public.topic_write_requests
    where owner_id = caller and request_id = p_request_id;
  if previous.request_id is not null then
    if previous.payload_hash <> payload_hash then
      raise exception 'Topic request conflict' using errcode = 'PT409', hint = 'satchel:conflict:topic_request';
    end if;
    return previous.result;
  end if;

  if p_expected_revision is null then
    insert into public.topics(owner_id, id, name, brief)
      values(caller, p_topic_id, btrim(p_name), btrim(p_brief))
      returning * into topic;
  else
    if is_agent and not (
      public.agent_can_access(p_topic_id, true)
      or private.agent_can_access_tasks(p_topic_id, 'write')
    ) then
      raise exception 'Topic write unavailable' using errcode = '42501', hint = 'satchel:refused:topic_write';
    end if;
    update public.topics
      set name = btrim(p_name), brief = btrim(p_brief)
      where owner_id = caller and id = p_topic_id and revision = p_expected_revision
      returning * into topic;
    if topic.id is null then
      raise exception 'Topic changed or unavailable' using errcode = 'PT409', hint = 'satchel:conflict:topic';
    end if;
  end if;

  if p_repository_action = 'link' then
    -- No longer refused when the repository already has a topic. The conflict
    -- target carries topic_id now, so a second link is a second row rather
    -- than a PT409.
    insert into public.topic_repositories(owner_id, topic_id, provider, repository)
      values(caller, p_topic_id, 'github', lower(btrim(p_repository)))
      on conflict(owner_id, provider, repository, topic_id) do nothing;
  elsif p_repository_action = 'unlink' then
    delete from public.topic_repositories
      where owner_id = caller and topic_id = p_topic_id and provider = 'github'
        and repository = lower(btrim(p_repository));
  end if;

  response := jsonb_build_object(
    'topic', to_jsonb(topic),
    'repositories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', repository.provider,
        'repository', repository.repository
      ) order by repository.provider, repository.repository)
      from public.topic_repositories repository
      where repository.owner_id = caller and repository.topic_id = p_topic_id
    ), '[]'::jsonb),
    'grant_required', is_agent and not (
      public.agent_can_access(p_topic_id, false)
      or private.agent_can_access_tasks(p_topic_id, 'read')
    )
  );

  insert into public.topic_write_requests(
    owner_id, request_id, payload_hash, topic_id, result
  ) values (caller, p_request_id, payload_hash, p_topic_id, response);
  return response;
exception when unique_violation then
  raise exception 'Topic request conflict' using errcode = 'PT409', hint = 'satchel:conflict:topic_request';
end;
$function$;

commit;
