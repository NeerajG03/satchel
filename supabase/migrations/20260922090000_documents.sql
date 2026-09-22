begin;

-- Documents: what was said, kept apart from what was remembered.
--
-- Capture today is a one-shot write. The router reads a five-row rolling
-- window, decides once, and the window is gone within 24 hours. So a better
-- prompt can never improve a past conversation, and a memory that turned out
-- to be wrong has no source left to re-read. Of the eight memories in
-- production on 21 September, three were worth keeping; there is no way to
-- re-derive the other five because the conversations that produced them no
-- longer exist.
--
-- A document is the durable half. Memories are derived from it and can be
-- derived again. See docs/memory-v2-5-scope.md, R1.
--
-- session_messages stays exactly as it is. It is the short working window the
-- Stop router reads, it lives 24 hours, and conflating the two would mean
-- either throwing the record away or keeping the window forever. Both writes
-- happen in one round trip through record_turn, because the hook that records
-- the user's half has a five second budget and must now wait for it.

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_key text not null check (length(session_key) between 1 and 200),
  -- Personal when null, exactly like a memory. Set by whichever turn first
  -- knows the scope and never cleared afterwards, because a session that
  -- resolved its repository once did not stop being that project.
  --
  -- A plain reference, not the (owner_id, id) composite the other tables use:
  -- a composite would have to set owner_id null alongside it, which the column
  -- forbids. Deleting a project must not delete the conversation.
  project_id uuid references public.projects(id) on delete set null,
  turns integer not null default 0,
  chars integer not null default 0,
  -- Set when the document stopped accepting turns. A long session is not a
  -- reason to hold an unbounded amount of conversation, and a reader has to be
  -- able to tell a short session from a truncated one.
  truncated_at timestamptz,
  started_at timestamptz not null default now(),
  last_turn_at timestamptz not null default now(),
  consolidated_at timestamptz,
  -- The last turn a consolidation pass has seen. A session that keeps going
  -- after a pass is pending again, and only the new turns are new.
  consolidated_through bigint,
  -- 30 days, then the conversation is deleted. Memories derived from it
  -- survive. This is the largest privacy surface in the system, so the
  -- deletion is a function with a row count rather than a policy sentence.
  expires_at timestamptz not null default now() + interval '30 days',
  unique (owner_id, session_key)
);

create table public.document_turns (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) between 1 and 8000),
  created_at timestamptz not null default now()
);

create index document_turns_document on public.document_turns(document_id, id);
create index documents_expiry on public.documents(expires_at);
create index documents_pending on public.documents(owner_id, last_turn_at);

alter table public.documents enable row level security;
alter table public.document_turns enable row level security;
revoke all on public.documents, public.document_turns from public, anon, authenticated;

-- No table grants, deliberately. This is conversation text, and an agent
-- connection is `authenticated` too: a select grant would let any granted
-- connection read every session regardless of which projects it was given.
-- Everything goes through the routines below, the same rule session_messages
-- has followed since it was added.

/* Retention, as a countable act.
 *
 * Runs across owners because it is housekeeping and every row it touches is
 * already past the retention every owner agreed to. Called from record_turn so
 * it needs no schedule, and callable on its own so a test can prove the
 * deletion is real. */
create function public.expire_documents() returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  delete from public.documents where expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

/* Appends one turn, and notes the scope whether or not there is a turn.
 *
 * Empty content is not an error and not a no-op: Codex hosts hand us no
 * assistant message, so the end of a turn there has nothing to append but is
 * still the moment the project is known. The document is created and scoped
 * first, and only then does the content decide whether a row is written. */
create function public.record_document_turn(
  p_session_key text, p_role text, p_content text, p_project_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  doc public.documents;
  body text := btrim(left(coalesce(p_content, ''), 8000));
  -- About 100k tokens of conversation. Past this the session stops being
  -- recorded rather than growing without a limit.
  cap constant integer := 400000;
  scope uuid := p_project_id;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  -- A project the caller does not own is a mistake, not a scope. Dropping it
  -- keeps the document personal, which is the harmless direction: a personal
  -- document is visible to its owner, and a wrongly scoped one is not.
  if scope is not null and not exists (
    select 1 from public.projects p where p.id = scope and p.owner_id = caller)
  then scope := null; end if;

  insert into public.documents as d (owner_id, session_key, project_id)
    values (caller, p_session_key, scope)
    on conflict (owner_id, session_key) do update
      set project_id = coalesce(excluded.project_id, d.project_id)
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
$$;

/* The one call both hooks make.
 *
 * Two writes with two different lifetimes: the rolling window the Stop router
 * reads in a few seconds, and the document a consolidation pass reads hours
 * later. One round trip, because the per-prompt hook pays for this one and it
 * must not delay the prompt. */
create function public.record_turn(
  p_session_key text, p_role text, p_content text,
  p_keep integer default 12, p_project_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare doc uuid;
begin
  perform public.record_session_message(p_session_key, p_role, p_content, p_keep);
  doc := public.record_document_turn(p_session_key, p_role, p_content, p_project_id);
  perform public.expire_documents();
  return doc;
end;
$$;

create function public.session_document(p_session_key text)
returns table(id uuid, project_id uuid, turns integer, chars integer,
              started_at timestamptz, last_turn_at timestamptz,
              consolidated_at timestamptz, consolidated_through bigint,
              truncated_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select d.id, d.project_id, d.turns, d.chars, d.started_at, d.last_turn_at,
         d.consolidated_at, d.consolidated_through, d.truncated_at, d.expires_at
  from public.documents d
  where d.owner_id = auth.uid() and d.session_key = p_session_key;
$$;

/* The conversation itself, oldest first, which is the order it has to be read
 * in. p_after asks for only what a previous pass did not see. */
create function public.document_content(p_document_id uuid, p_after bigint default null)
returns table(id bigint, role text, content text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select t.id, t.role, t.content, t.created_at
  from public.document_turns t
  where t.owner_id = auth.uid() and t.document_id = p_document_id
    and (p_after is null or t.id > p_after)
  order by t.id;
$$;

/* What is ready to be consolidated: idle long enough to be finished, and
 * holding at least one turn nobody has read yet. A session still being typed
 * into is not ready, and re-reading a document that has not changed is a model
 * call spent on nothing. */
create function public.pending_documents(p_idle_minutes integer default 30, p_limit integer default 20)
returns table(id uuid, session_key text, project_id uuid, turns integer, chars integer,
              last_turn_at timestamptz, consolidated_at timestamptz, consolidated_through bigint)
language sql stable security definer set search_path = '' as $$
  select d.id, d.session_key, d.project_id, d.turns, d.chars, d.last_turn_at,
         d.consolidated_at, d.consolidated_through
  from public.documents d
  where d.owner_id = auth.uid()
    and d.last_turn_at < now() - make_interval(mins => greatest(coalesce(p_idle_minutes, 30), 0))
    and exists (
      select 1 from public.document_turns t
      where t.document_id = d.id
        and (d.consolidated_through is null or t.id > d.consolidated_through))
  order by d.last_turn_at
  limit greatest(coalesce(p_limit, 20), 1);
$$;

/* Moves only forward. A pass that read fewer turns than an earlier one must
 * not make the earlier turns pending again. */
create function public.mark_document_consolidated(p_document_id uuid, p_through bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.documents
    set consolidated_at = now(),
        consolidated_through = greatest(coalesce(consolidated_through, 0), coalesce(p_through, 0))
    where owner_id = caller and id = p_document_id;
end;
$$;

revoke execute on function
  public.expire_documents(),
  public.record_document_turn(text,text,text,uuid),
  public.record_turn(text,text,text,integer,uuid),
  public.session_document(text),
  public.document_content(uuid,bigint),
  public.pending_documents(integer,integer),
  public.mark_document_consolidated(uuid,bigint) from public, anon;
grant execute on function
  public.expire_documents(),
  public.record_document_turn(text,text,text,uuid),
  public.record_turn(text,text,text,integer,uuid),
  public.session_document(text),
  public.document_content(uuid,bigint),
  public.pending_documents(integer,integer),
  public.mark_document_consolidated(uuid,bigint) to authenticated;

commit;
