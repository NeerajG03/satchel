begin;

-- An app may only merge away a topic Satchel made. The tidy already keeps to
-- this, and the database now holds every other app to it as well: a topic a
-- person made is theirs to merge, from the companion. Same signature, so the
-- grants from 20261008090000 still apply.
create or replace function public.merge_topic(p_from uuid, p_into uuid, p_note text default null,
  p_trace text default null)
returns public.topic_merges language plpgsql security definer set search_path = '' as $$
declare
  source public.projects;
  target public.projects;
  moved uuid[];
  merge public.topic_merges;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select * into source from public.projects where id = p_from and owner_id = auth.uid() for update;
  select * into target from public.projects where id = p_into and owner_id = auth.uid();
  if source.id is null or target.id is null or source.id = target.id
    or source.merged_into is not null or target.merged_into is not null then
    raise exception 'Topic changed or unavailable' using errcode = 'PT409';
  end if;
  if not private.may_write_scope(source.id) or not private.may_write_scope(target.id) then
    raise exception 'Project write unavailable' using errcode = '42501';
  end if;
  if auth.jwt()->>'client_id' is not null and source.made_by <> 'satchel' then
    raise exception 'Topic has tasks or repositories' using errcode = '23514';
  end if;
  if exists (select 1 from public.tasks where project_id = source.id)
    or exists (select 1 from public.project_repositories where project_id = source.id) then
    raise exception 'Topic has tasks or repositories' using errcode = '23514';
  end if;
  with shifted as (
    update public.memories set project_id = target.id
      where project_id = source.id and owner_id = auth.uid() and ended_at is null
      returning id, owner_id
  ), logged as (
    insert into public.memory_events(owner_id, memory_id, action, before, after, actor, reason, trace_id)
      select owner_id, id, 'moved', source.slug, target.slug, private.memory_actor(),
             left(coalesce(p_note, 'merged into ' || target.slug), 500), left(p_trace, 200)
      from shifted
      returning memory_id
  )
  select coalesce(array_agg(memory_id), '{}') into moved from logged;
  update public.projects set merged_into = target.id where id = source.id;
  insert into public.topic_merges(owner_id, from_id, into_id, memory_ids, actor, reason)
    values (auth.uid(), source.id, target.id, moved, private.memory_actor(), left(p_note, 500))
    returning * into merge;
  return merge;
end;
$$;

commit;
