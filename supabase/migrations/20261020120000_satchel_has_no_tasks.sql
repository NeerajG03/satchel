begin;

-- Satchel has no tasks. The person tracks work in Notion, and Satchel is
-- memory and topics. The app, the agent tools and the plugin stopped using
-- tasks first; this takes them out of the database.
--
-- Everything here was tasks only, except the routines that are redefined
-- below without their task parts: consent, revoke, connection status, topic
-- upsert, delete and merge, slugs, and the rule that lets an app read a topic.
-- The person chose to drop the 8 tasks in production with no backup. The two
-- files in the task-files bucket are deleted through the Storage API, not
-- here, because storage.objects refuses direct deletes.

-- Who is making a change. Memory history used the task helper for this, so it
-- moves to a name that is not about tasks before that helper goes.
CREATE OR REPLACE FUNCTION private.request_actor()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when (select auth.uid()) is null then null
    when ((select auth.jwt())->>'client_id') is null then 'user:' || (select auth.uid())::text
    else 'agent:' || ((select auth.jwt())->>'client_id')
  end;
$function$;
revoke all on function private.request_actor() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION private.memory_actor()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    nullif(current_setting('satchel.actor', true), ''),
    private.request_actor(),
    'unknown');
$function$;

CREATE OR REPLACE FUNCTION public.agent_connection_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'client_id', c.client_id,
    'label', c.label,
    'personal', c.personal,
    'all_topics', c.all_topics,
    'topic_ids', c.topic_ids,
    'can_write', c.can_write
  )
  from public.agent_connections c
  where c.owner_id = auth.uid()
    and c.client_id = auth.jwt()->>'client_id'
    and c.grant_id::text = auth.jwt()->>'satchel_grant_id'
    and c.revoked_at is null;
$function$;

-- Consent, memory only. A new name because the arguments changed, and the
-- web app switches to it in the same change.
CREATE OR REPLACE FUNCTION public.authorize_agent_v4(p_client_id text, p_label text, p_personal boolean, p_all_topics boolean, p_topic_ids uuid[], p_can_write boolean)
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
begin
  if auth.uid() is null then
    raise exception 'Companion sign-in required' using errcode = '42501', hint = 'satchel:session';
  end if;
  if auth.jwt()->>'client_id' is not null then
    raise exception 'Companion sign-in required' using errcode = '42501', hint = 'satchel:app_token';
  end if;
  if p_topic_ids is null
    or cardinality(p_topic_ids) > 100
    or array_position(p_topic_ids, null) is not null
    or exists (
      select 1 from unnest(p_topic_ids) p
      where not exists (
        select 1 from public.topics where id = p and owner_id = auth.uid()
      )
    ) then
    raise exception 'Invalid topic selection' using errcode = '42501', hint = 'satchel:refused:topic_selection';
  end if;
  -- A blanket grant is a scope, so it satisfies this on its own.
  if not p_personal and not p_all_topics and cardinality(p_topic_ids) = 0 then
    raise exception 'Select a memory scope' using errcode = '23514', hint = 'satchel:invalid:no_scope';
  end if;

  insert into public.agent_connections(
    owner_id, client_id, label, personal, all_topics, topic_ids, can_write, grant_id
  ) values (
    auth.uid(), p_client_id, btrim(p_label), p_personal, p_all_topics, memory_ids, p_can_write, next_grant
  )
  on conflict(owner_id, client_id) do update set
    label = excluded.label,
    personal = excluded.personal,
    all_topics = excluded.all_topics,
    topic_ids = excluded.topic_ids,
    can_write = excluded.can_write,
    revoked_at = null,
    grant_id = excluded.grant_id;

end;
$function$;
revoke all on function public.authorize_agent_v4(text, text, boolean, boolean, uuid[], boolean) from public, anon, authenticated;
grant execute on function public.authorize_agent_v4(text, text, boolean, boolean, uuid[], boolean) to authenticated;
do $grants$ begin if exists (select 1 from pg_roles where rolname = 'service_role') then
  execute 'grant execute on function public.authorize_agent_v4(text, text, boolean, boolean, uuid[], boolean) to service_role';
end if; end $grants$;

-- The oldest signature still clears a blanket grant rather than keeping one.
CREATE OR REPLACE FUNCTION public.authorize_agent(p_client_id text, p_label text, p_personal boolean, p_topic_ids uuid[], p_can_write boolean)
 RETURNS void
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select public.authorize_agent_v4(p_client_id, p_label, p_personal, false, p_topic_ids, p_can_write);
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
  update public.agent_connections
    set revoked_at = now(), grant_id = gen_random_uuid()
    where owner_id = auth.uid() and client_id = p_client_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.default_slug()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare base text; candidate text; suffix integer := 1; fields jsonb;
begin
  if new.slug is not null then return new; end if;
  fields := to_jsonb(new);
  base := public.slugify(coalesce(fields->>'title', fields->>'name', 'item'));
  candidate := base;
  loop
    exit when not exists (
      select 1 from public.topics p where p.owner_id = new.owner_id and p.slug = candidate);
    suffix := suffix + 1;
    candidate := trim(both '-' from substring(base from 1 for 36)) || '-' || suffix;
  end loop;
  new.slug := candidate;
  return new;
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
  if p_kind <> 'topic' then
    raise exception 'Unknown slug kind' using errcode = '23514', hint = 'satchel:fault:slug_kind';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) > 40 then
    raise exception 'A slug is lowercase words joined by hyphens, up to 40 characters' using errcode = '23514', hint = 'satchel:invalid:slug_shape';
  end if;
  -- Excludes the row being renamed, which is what makes renaming to the
  -- current slug a no-op rather than a conflict.
  if exists (
    select 1 from public.topics p
      where p.owner_id = caller and p.slug = p_slug and p.id <> p_id
  ) then
    raise exception 'That slug is already in use' using errcode = '23505', hint = 'satchel:invalid:slug_taken';
  end if;
  update public.topics set slug = p_slug where owner_id = caller and id = p_id;
  get diagnostics touched = row_count;
  if touched = 0 then raise exception 'Record not found' using errcode = 'P0002', hint = 'satchel:gone:record'; end if;
  return p_slug;
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
  memory_count integer;
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

  update public.agent_connections set topic_ids = array_remove(topic_ids, p_id)
    where owner_id = auth.uid() and p_id = any(topic_ids);
  delete from public.topics where owner_id = auth.uid() and id = p_id;
  return jsonb_build_object('id', p_id, 'name', target.name,
    'memories_removed', memory_count);
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
    raise exception 'Topic has work only its owner may move' using errcode = '23514', hint = 'satchel:invalid:topic_has_work';
  end if;
  if exists (select 1 from public.topic_repositories where topic_id = source.id) then
    raise exception 'Topic has work only its owner may move' using errcode = '23514', hint = 'satchel:invalid:topic_has_work';
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
        and c.can_write
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
    if is_agent and not public.agent_can_access(p_topic_id, true) then
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
    'grant_required', is_agent and not public.agent_can_access(p_topic_id, false)
  );

  insert into public.topic_write_requests(
    owner_id, request_id, payload_hash, topic_id, result
  ) values (caller, p_request_id, payload_hash, p_topic_id, response);
  return response;
exception when unique_violation then
  raise exception 'Topic request conflict' using errcode = 'PT409', hint = 'satchel:conflict:topic_request';
end;
$function$;

-- An app sees a topic when it may read that topic's memories. Task access
-- used to count too.
alter policy agent_topic_read on public.topics
  using ((owner_id = (select auth.uid())) and public.agent_can_access(id, false));

-- The task-files bucket's rules. The bucket and its two files go through the
-- Storage API.
do $storage$ begin if exists (select 1 from pg_namespace where nspname = 'storage') then
  drop policy if exists task_file_download on storage.objects;
  drop policy if exists task_file_upload on storage.objects;
  drop policy if exists task_file_owner_read on storage.objects;
  drop policy if exists task_file_owner_delete on storage.objects;
end if; end $storage$;

-- Routines that hand back a task row depend on the table, and the tables'
-- read rules depend on the private helpers, so the order is: public routines,
-- then the tables, then the helpers. Each by name, whatever its arguments.
create function pg_temp.drop_routines(p_schema text, p_names text[]) returns void
language plpgsql as $drop$
declare routine regprocedure;
begin
  for routine in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = p_schema and p.proname = any(p_names)
  loop
    execute format('drop function %s', routine);
  end loop;
end $drop$;

select pg_temp.drop_routines('public', array[
  'add_task_comment', 'add_task_dependency', 'add_task_resource', 'authorize_agent_v2',
  'authorize_agent_v3', 'cleanup_task_file', 'create_task', 'create_task_with_slug',
  'delete_task', 'export_tasks', 'fail_task_file', 'finalize_task_file',
  'record_task_handoff', 'record_task_progress', 'remove_task_dependency',
  'reserve_task_file', 'save_task_edit', 'set_task_parent', 'transition_task', 'update_task']);

drop view public.task_planning;
drop table public.task_update_resource_refs, public.handoff_resource_refs, public.task_updates,
  public.task_handoffs, public.task_resources, public.task_events, public.task_write_requests,
  public.task_parent_edges, public.task_dependencies, public.agent_task_grants, public.tasks;

alter table public.agent_connections
  drop column task_personal, drop column task_all_topics,
  drop column task_can_write, drop column task_can_upload;

select pg_temp.drop_routines('private', array[
  'agent_can_access_tasks', 'can_read_task_object', 'can_upload_task_object',
  'task_actor', 'task_can_access', 'task_request_seen', 'touch_task_activity']);

commit;
