begin;

-- Topics. A topic is a project the overnight pass may make for itself, so a
-- work fact that fits no project has a home other than personal. Nothing here
-- renames a table: a project and a topic are the same row. See docs/topics.md.
--
-- Additive only. Every column has a default, every function is new, and the one
-- constraint that changes only grows its list. Code from before this migration
-- runs against it unchanged.

-- Who made it. The page marks the ones Satchel made, and only those are ever
-- merged by the pass.
alter table public.projects add column made_by text not null default 'person'
  check (made_by in ('person', 'satchel'));

-- A merged topic is kept, pointing at the one it went into, so undoing the
-- merge has a row to come back to. It is left out of every list.
alter table public.projects add column merged_into uuid
  references public.projects(id) on delete set null;
alter table public.projects add constraint projects_not_merged_into_itself
  check (merged_into is null or merged_into <> id);

alter table public.memory_events drop constraint memory_events_action_check;
alter table public.memory_events add constraint memory_events_action_check
  check (action in ('added', 'corrected', 'confirmed', 'extended',
                    'replaced', 'retired', 'forgotten', 'restored', 'moved'));

-- One row per merge: which memories moved, so the undo moves exactly those
-- back and nothing filed into the topic since.
create table public.topic_merges (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_id uuid not null references public.projects(id) on delete cascade,
  into_id uuid not null references public.projects(id) on delete cascade,
  memory_ids uuid[] not null default '{}',
  actor text not null,
  reason text check (length(reason) <= 500),
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create index topic_merges_from on public.topic_merges(owner_id, from_id, created_at desc);
alter table public.topic_merges enable row level security;
revoke all on public.topic_merges from public, anon, authenticated;
grant select on public.topic_merges to authenticated;
create policy reads_own_merges on public.topic_merges for select to authenticated
  using (owner_id = (select auth.uid()));

-- May the caller write in this scope. The companion owns everything it can
-- see; an agent goes through its grant, as every other memory write does.
create function private.may_write_scope(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when auth.jwt()->>'client_id' is null then
      p_project_id is null or exists (select 1 from public.projects p
        where p.id = p_project_id and p.owner_id = auth.uid())
    else public.agent_can_access(p_project_id, true)
  end;
$$;

create function private.scope_name(p_project_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select slug from public.projects where id = p_project_id), 'personal');
$$;

/* A memory into another topic, or into personal with null.
 *
 * Not an edit of the claim: the statement, its band and how often it was said
 * all stay, which is the reason this exists rather than a replace. The caller
 * has to be able to write on both sides, and the history says where it was. */
create function public.move_memory(
  p_id uuid, p_revision integer, p_project_id uuid,
  p_note text default null, p_trace text default null, p_document uuid default null
) returns public.memories language plpgsql security definer set search_path = '' as $$
declare
  current public.memories;
  result public.memories;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select * into current from public.memories
    where id = p_id and owner_id = auth.uid() and revision = p_revision and ended_at is null
    for update;
  if current.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  if not private.may_write_scope(current.project_id) or not private.may_write_scope(p_project_id) then
    raise exception 'Memory write unavailable' using errcode = '42501';
  end if;
  if p_project_id is not null and exists (select 1 from public.projects
      where id = p_project_id and merged_into is not null) then
    raise exception 'Topic was merged' using errcode = '23514';
  end if;
  if current.project_id is not distinct from p_project_id then return current; end if;
  update public.memories set project_id = p_project_id where id = p_id returning * into result;
  insert into public.memory_events(owner_id, memory_id, action, before, after, actor, reason, trace_id, document_id)
    values (current.owner_id, p_id, 'moved', private.scope_name(current.project_id),
            private.scope_name(p_project_id), private.memory_actor(), left(p_note, 500),
            left(p_trace, 200), p_document);
  return result;
end;
$$;

/* A topic the pass made for itself. The same write path as any project, so the
 * grant rules and the slug check are the ones that already hold, then marked. */
create function public.create_topic(
  p_request_id uuid, p_project_id uuid, p_slug text, p_name text, p_brief text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare response jsonb;
begin
  response := public.upsert_project_with_slug(p_slug, p_request_id, p_project_id, null,
    p_name, p_brief, 'unchanged', null);
  update public.projects set made_by = 'satchel'
    where id = p_project_id and owner_id = auth.uid();
  return response;
end;
$$;

/* Two topics that are one thing become one.
 *
 * Refused for a topic with tasks or repository links: those were set up by a
 * person and a task has exactly one home. The topic merged away is kept and
 * hidden, and the row in topic_merges is what the undo reads. */
create function public.merge_topic(p_from uuid, p_into uuid, p_note text default null,
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

/* The last merge of this topic, taken back. Only the memories that merge moved,
 * and only those still sitting where it put them. */
create function public.unmerge_topic(p_from uuid)
returns public.topic_merges language plpgsql security definer set search_path = '' as $$
declare
  source public.projects;
  merge public.topic_merges;
  into_slug text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select * into source from public.projects where id = p_from and owner_id = auth.uid() for update;
  if source.id is null or source.merged_into is null then
    raise exception 'Topic changed or unavailable' using errcode = 'PT409';
  end if;
  if not private.may_write_scope(source.id) or not private.may_write_scope(source.merged_into) then
    raise exception 'Project write unavailable' using errcode = '42501';
  end if;
  select * into merge from public.topic_merges
    where from_id = source.id and owner_id = auth.uid() and undone_at is null
    order by created_at desc limit 1 for update;
  into_slug := private.scope_name(source.merged_into);
  update public.projects set merged_into = null where id = source.id;
  if merge.id is not null then
    with back as (
      update public.memories set project_id = source.id
        where id = any(merge.memory_ids) and project_id = merge.into_id
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
$$;

revoke all on function private.may_write_scope(uuid), private.scope_name(uuid) from public, anon;
grant execute on function private.may_write_scope(uuid), private.scope_name(uuid) to authenticated;
revoke all on function
  public.move_memory(uuid, integer, uuid, text, text, uuid),
  public.create_topic(uuid, uuid, text, text, text),
  public.merge_topic(uuid, uuid, text, text),
  public.unmerge_topic(uuid)
  from public, anon;
grant execute on function
  public.move_memory(uuid, integer, uuid, text, text, uuid),
  public.create_topic(uuid, uuid, text, text, text),
  public.merge_topic(uuid, uuid, text, text),
  public.unmerge_topic(uuid)
  to authenticated;

commit;
