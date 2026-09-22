begin;

-- A memory can end without being destroyed, and every change to one is an
-- event with a before and an after.
--
-- Until now nothing ever revisited a memory. There was no supersede, no
-- expiry, no review and no history, so a memory died exactly one way: a person
-- deleted it. That is what the production numbers showed happening, about six
-- of twelve captured rows deleted by hand in two days. The user is the cleanup
-- pass, which is not a design.
--
-- Two halves, and the second is the one that makes the first safe. Auto-apply
-- consolidation without an undo is not acceptable, so the history table is
-- load bearing rather than nice to have. See docs/memory-v2-5-scope.md, R4 and
-- R5, plus the R6 columns the same pass will write.

-- One way to stop being live, with a reason, rather than four flag pairs:
--
--   replaced  the claim is false now, and ended_by names what replaced it
--   retired   an intent was fulfilled. "I want entries append only" is spent
--             the moment they are, and that is not the same as being wrong
--   forgotten a person or a pass decided it should not be there
--
-- Expiry is separate because it is time passing rather than something
-- happening: a row with an expires_at in the past is not live and no event
-- was ever raised for it.
alter table public.memories
  add column kind text not null default 'fact'
    check (kind in ('fact', 'preference', 'intent')),
  add column ended_at timestamptz,
  add column ended_reason text check (ended_reason in ('replaced', 'retired', 'forgotten')),
  add column ended_by uuid references public.memories(id) on delete set null,
  add column ended_note text check (length(ended_note) <= 500),
  add column expires_at timestamptz,
  -- The last time anyone said this again. Repetition is a precision signal we
  -- were throwing away: a claim restated across sessions is stronger than one
  -- said once, and it is free.
  add column affirmed_at timestamptz not null default now(),
  add column mentions integer not null default 1 check (mentions >= 1),
  add constraint memories_ended_together
    check ((ended_at is null) = (ended_reason is null)),
  add constraint memories_ended_by_only_when_replaced
    check (ended_by is null or ended_reason = 'replaced');

-- Live is the default question every reader asks, so it is the indexed one.
create index memories_live on public.memories(owner_id, project_id)
  where ended_at is null;

grant insert(statement, source, band, kind, expires_at) on public.memories to authenticated;
grant update(statement, source, band, kind, expires_at,
  ended_at, ended_reason, ended_by, ended_note, affirmed_at, mentions)
  on public.memories to authenticated;

-- What happened to a memory, and why, and which model run did it.
--
-- memory_id cascades. The system never deletes a memory, it ends one, so the
-- only thing that removes these rows is a person deleting the memory outright,
-- and taking the history of a thing they asked to be gone is the right
-- behaviour rather than a gap.
create table public.memory_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  memory_id uuid not null references public.memories(id) on delete cascade,
  action text not null check (action in (
    'added', 'corrected', 'confirmed', 'extended', 'replaced', 'retired', 'forgotten')),
  before text,
  after text,
  reason text check (length(reason) <= 500),
  actor text not null,
  -- R11. A row in the database and the reasoning that produced it are one
  -- click apart, in both directions. Without this a background pass that
  -- writes memory while nobody is watching is unauditable in exactly the way
  -- the current design is.
  trace_id text check (length(trace_id) <= 200),
  document_id uuid references public.documents(id) on delete set null,
  created_at timestamptz not null default now()
);
create index memory_events_memory on public.memory_events(memory_id, created_at, id);
alter table public.memory_events enable row level security;
revoke all on public.memory_events from public, anon, authenticated;
grant select on public.memory_events to authenticated;

-- Visibility is exactly the visibility of the memory it describes, worked out
-- by the policies on that table rather than restated here. A second copy of
-- the grant rules is a second place for them to drift, and this one would be
-- the copy nobody remembers to update.
create policy reads_events_for_visible_memories on public.memory_events
  for select to authenticated
  using (exists (select 1 from public.memories m where m.id = memory_id));

/* Who is making this change.
 *
 * private.task_actor() already answers "a person or which agent", and this
 * adds the third answer that did not exist before: a background pass, which
 * belongs to nobody's keystroke. */
create function private.memory_actor() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    nullif(current_setting('satchel.actor', true), ''),
    private.task_actor(),
    'unknown');
$$;

/* Every change to a memory, recorded by the database rather than by whoever
 * remembered to.
 *
 * A trigger and not a call in each writer, for the reason capture shipped for
 * weeks without embedding its own rows: the one writer nobody checks
 * afterwards is the one that silently skips a step. This cannot be skipped.
 *
 * Context is best effort on top of that. satchel.trace_id, satchel.document_id
 * and satchel.reason are set inside the routines below, in the same
 * transaction, so a write that goes straight at the table still gets an event,
 * just a plainer one. */
create function private.record_memory_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  act text := private.memory_actor();
  trace text := nullif(current_setting('satchel.trace_id', true), '');
  doc uuid := nullif(current_setting('satchel.document_id', true), '')::uuid;
  note text := nullif(current_setting('satchel.reason', true), '');
  -- Enrichment only, and only in the direction that cannot lie: a statement
  -- change may be labelled an extension rather than a correction, which is
  -- R5's distinction. Nothing can relabel a replace as an add.
  override text := nullif(current_setting('satchel.change', true), '');
  happened text;
begin
  if tg_op = 'INSERT' then
    insert into public.memory_events(owner_id, memory_id, action, after, actor, reason, trace_id, document_id)
      values (new.owner_id, new.id, 'added', new.statement, act, note, trace, doc);
    return new;
  end if;
  if new.ended_at is not null and old.ended_at is null then happened := new.ended_reason;
  elsif new.statement is distinct from old.statement then
    happened := case when override = 'extended' then 'extended' else 'corrected' end;
  elsif new.band is distinct from old.band and new.band = 'said' then happened := 'confirmed';
  end if;
  -- Embedding a row, affirming it, or setting an expiry is bookkeeping. The
  -- revision trigger already draws that line and this one draws the same one.
  if happened is null then return new; end if;
  insert into public.memory_events(owner_id, memory_id, action, before, after, actor, reason, trace_id, document_id)
    values (new.owner_id, new.id, happened, old.statement, new.statement, act, note, trace, doc);
  return new;
end;
$$;
create trigger record_memory_event after insert or update on public.memories
  for each row execute function private.record_memory_event();

-- Ending a memory is a change to it, so it moves the revision: a client
-- holding the old one must not go on to correct a memory that is no longer
-- live. Affirming, expiring and embedding are not.
create or replace function public.stamp_memory_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.statement is not distinct from old.statement
    and new.source is not distinct from old.source
    and new.more_info is not distinct from old.more_info
    and new.name is not distinct from old.name
    and new.band is not distinct from old.band
    and new.project_id is not distinct from old.project_id
    and new.kind is not distinct from old.kind
    and new.ended_at is not distinct from old.ended_at
  then
    new.revision := old.revision;
    new.updated_at := old.updated_at;
    return new;
  end if;
  new.revision := old.revision + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

/* Sets the context the trigger reads, for the length of this transaction.
 *
 * It has to be an argument rather than a separate call, because every request
 * through PostgREST is its own transaction and a set_config from outside would
 * not be there when the write happens. */
create function private.attribute(p_trace text, p_document uuid, p_reason text)
returns void language sql volatile security definer set search_path = '' as $$
  select
    set_config('satchel.trace_id', coalesce(left(p_trace, 200), ''), true),
    set_config('satchel.document_id', coalesce(p_document::text, ''), true),
    set_config('satchel.reason', coalesce(left(p_reason, 500), ''), true);
  select null::void;
$$;

/* A memory stops being live. Nothing is destroyed.
 *
 * p_ended_by names the memory that replaced this one, which is supermemory's
 * `updates` edge: retrieval follows the live row and the old wording is still
 * there to explain how it got there. */
create function public.end_memory(
  p_id uuid, p_revision integer, p_reason text, p_ended_by uuid default null,
  p_note text default null, p_trace text default null, p_document uuid default null
) returns public.memories language plpgsql security invoker set search_path = '' as $$
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
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

/* Enrichment, not replacement. Most of what looks like a contradiction is one
 * claim getting more detailed, and treating that as a replacement throws the
 * detail away. The event says `extended` so the history can tell them apart. */
create function public.extend_memory(
  p_id uuid, p_revision integer, p_statement text,
  p_trace text default null, p_document uuid default null
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  perform private.attribute(p_trace, p_document, null);
  perform set_config('satchel.change', 'extended', true);
  update public.memories
    set statement = btrim(p_statement), affirmed_at = now(), mentions = mentions + 1
    where id = p_id and revision = p_revision and ended_at is null
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

/* Said again. Not an edit and not an event: the wording did not change, the
 * evidence for it did. */
create function public.affirm_memory(p_id uuid)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  update public.memories set affirmed_at = now(), mentions = mentions + 1
    where id = p_id and ended_at is null returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

create function public.memory_history(p_id uuid)
returns table(id uuid, action text, before text, after text, reason text,
              actor text, trace_id text, document_id uuid, created_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select e.id, e.action, e.before, e.after, e.reason,
         e.actor, e.trace_id, e.document_id, e.created_at
  from public.memory_events e
  where e.memory_id = p_id
  order by e.created_at, e.id;
$$;

-- Live only, everywhere a memory is read to be used. What ended is archive:
-- readable on request, never injected.
drop function public.personal_memories();
create function public.personal_memories()
returns table(id uuid, statement text, band text, kind text, mentions integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.statement, m.band, m.kind, m.mentions, m.updated_at
  from public.memories m
  where m.project_id is null
    and m.ended_at is null
    and (m.expires_at is null or m.expires_at > now())
  order by m.updated_at desc, m.id;
$$;

drop function public.list_memories(uuid);
create function public.list_memories(p_project_id uuid)
returns table(id uuid, project_id uuid, statement text, band text, kind text,
  name text, has_more_info boolean, mentions integer, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.statement, m.band, m.kind, m.name,
    length(btrim(m.more_info)) > 0, m.mentions, m.revision, m.updated_at
  from public.memories m
  where m.project_id is not distinct from p_project_id
    and m.ended_at is null
    and (m.expires_at is null or m.expires_at > now())
  order by m.updated_at desc, m.id;
$$;

drop function public.all_memories();
create function public.all_memories()
returns table(id uuid, project_id uuid, statement text, band text, kind text,
  name text, has_more_info boolean, mentions integer, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.statement, m.band, m.kind, m.name,
    length(btrim(m.more_info)) > 0, m.mentions, m.revision, m.updated_at
  from public.memories m
  where m.ended_at is null
    and (m.expires_at is null or m.expires_at > now())
  order by m.updated_at desc, m.id;
$$;

/* Everything that stopped being live, and how. This is the undo: auto-apply
 * consolidation is only acceptable because this exists and because nothing it
 * ends is actually gone. */
create function public.archived_memories()
returns table(id uuid, project_id uuid, statement text, band text, kind text,
  ended_at timestamptz, ended_reason text, ended_by uuid, ended_note text,
  expires_at timestamptz, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.statement, m.band, m.kind,
    m.ended_at, m.ended_reason, m.ended_by, m.ended_note,
    m.expires_at, m.revision, m.updated_at
  from public.memories m
  where m.ended_at is not null or (m.expires_at is not null and m.expires_at <= now())
  order by coalesce(m.ended_at, m.expires_at) desc, m.id;
$$;

drop function public.search_memories(extensions.vector(768), uuid, integer, real, real, uuid[]);
create function public.search_memories(
  p_query extensions.vector(768),
  p_in_scope uuid default null,
  p_limit integer default 5,
  p_gate real default 0.67,
  p_boost real default 1.1,
  p_exclude uuid[] default '{}'
) returns table(
  id uuid, project_id uuid, statement text, band text, kind text,
  score real, matched integer, in_scope integer
) language sql stable security invoker set search_path = '' as $$
  with settings as (
    select coalesce(p_gate, 0.67::real) as gate,
           coalesce(p_boost, 1.1::real) as boost,
           greatest(coalesce(p_limit, 5), 0) as cap,
           coalesce(p_exclude, '{}'::uuid[]) as excluded
  ), visible as (
    select m.id, m.project_id, m.statement, m.band, m.kind,
      (1 - (m.embedding OPERATOR(extensions.<=>) p_query))::real
        * case when p_in_scope is not null and m.project_id = p_in_scope
               then s.boost else 1 end as score
    from public.memories m, settings s
    where m.embedding is not null
      and m.ended_at is null
      and (m.expires_at is null or m.expires_at > now())
      and not (m.id = any(s.excluded))
  ), scored as (
    select v.*, count(*) over () as in_scope,
      count(*) filter (where v.score >= (select gate from settings)) over () as matched
    from visible v
  )
  select id, project_id, statement, band, kind, score,
    matched::integer, in_scope::integer
  from scored
  where score >= (select gate from settings)
  order by score desc, id
  limit (select cap from settings);
$$;

-- A kind is part of what a memory is, so it is set on the way in rather than
-- corrected afterwards. Appended to the signature so every existing positional
-- caller still resolves, and folded into the retry check, because two saves of
-- the same id that disagree about the kind are two different memories.
drop function public.save_memory(uuid, uuid, text, text, text, text, text);
create function public.save_memory(
  p_id uuid, p_project_id uuid, p_statement text, p_source text default '',
  p_band text default 'said',
  p_name text default null, p_more_info text default '', p_kind text default 'fact'
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  insert into public.memories(id, project_id, statement, source, band, name, more_info, kind)
    values(p_id, p_project_id, btrim(p_statement), p_source, p_band,
           nullif(btrim(coalesce(p_name, '')), ''), p_more_info, p_kind)
    on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  if result.id is null
    or result.project_id is distinct from p_project_id
    or result.statement is distinct from btrim(p_statement)
    or result.band is distinct from p_band
    or result.kind is distinct from p_kind then
    raise exception 'Memory request conflict' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

-- The automatic writer carries its own provenance now: which run wrote this,
-- and which conversation it came out of.
drop function public.capture_memory(uuid, text, text, text);
create function public.capture_memory(
  p_id uuid, p_statement text, p_source text, p_project_slug text default null,
  p_kind text default 'fact', p_trace text default null, p_document uuid default null
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target_project uuid;
  result public.memories;
begin
  perform private.attribute(p_trace, p_document, null);
  if p_project_slug is not null then
    select id into target_project from public.projects
      where owner_id = caller and slug = p_project_slug;
  end if;
  select * into result from public.save_memory(
    p_id, target_project, p_statement, p_source, 'heard', null, '', p_kind);
  return result;
end;
$$;

revoke execute on function
  private.memory_actor(), private.record_memory_event(), private.attribute(text,uuid,text)
  from public, anon, authenticated;
-- The routines below are security invoker, so RLS stays authoritative on the
-- write itself, and that means the caller needs this one. It writes nothing:
-- three transaction-local settings the trigger reads as enrichment. The parts
-- that must not be forgeable are not in it. The actor is derived from the JWT
-- and the action from the row change, so the worst a caller can do is put a
-- wrong trace id on the history of their own memory.
grant execute on function private.attribute(text,uuid,text) to authenticated;
revoke execute on function
  public.save_memory(uuid,uuid,text,text,text,text,text,text),
  public.end_memory(uuid,integer,text,uuid,text,text,uuid),
  public.extend_memory(uuid,integer,text,text,uuid),
  public.affirm_memory(uuid),
  public.memory_history(uuid),
  public.personal_memories(),
  public.list_memories(uuid),
  public.all_memories(),
  public.archived_memories(),
  public.search_memories(extensions.vector(768),uuid,integer,real,real,uuid[]),
  public.capture_memory(uuid,text,text,text,text,text,uuid)
  from public, anon;
grant execute on function
  public.save_memory(uuid,uuid,text,text,text,text,text,text),
  public.end_memory(uuid,integer,text,uuid,text,text,uuid),
  public.extend_memory(uuid,integer,text,text,uuid),
  public.affirm_memory(uuid),
  public.memory_history(uuid),
  public.personal_memories(),
  public.list_memories(uuid),
  public.all_memories(),
  public.archived_memories(),
  public.search_memories(extensions.vector(768),uuid,integer,real,real,uuid[]),
  public.capture_memory(uuid,text,text,text,text,text,uuid)
  to authenticated;

commit;
