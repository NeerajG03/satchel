begin;

-- Which codebase a conversation ran in.
--
-- The pass reads a conversation hours later with no workspace to look at. When
-- the repository names one project, the document is scoped at the end of the
-- turn. When it names several, or none is linked, the document stays personal
-- and the pass had no way to tell that the talk was about the email project
-- rather than the rate limiter. On 1 October 9 of 16 sessions were unscoped
-- and the blind read put 5 project memories on them.
--
-- The repository is the normalized owner/name the hooks already send, the same
-- shape project_repositories holds. It narrows the choice for the pass; it
-- links nothing and grants nothing. A value that is not that shape is dropped,
-- not refused, because the hook that sends it must never fail on it.
alter table public.documents add column repository text
  check (repository is null or (length(repository) <= 201 and repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'));

/* Notes the codebase on a session's document. Its own routine rather than a
 * new argument on record_turn: that one is on the per-prompt hook's five
 * second budget and its signature is what every older plugin package calls.
 * The latest repository wins, since a session can change directory. */
create function public.note_document_repository(p_session_key text, p_repository text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  repo text := lower(btrim(coalesce(p_repository, '')));
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if length(repo) > 201 or repo !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' then return; end if;
  update public.documents set repository = repo
    where owner_id = caller and session_key = p_session_key;
end;
$$;

-- Same columns as before, with the repository after them. A function that
-- returns a table cannot change its columns in place.
drop function public.pending_documents(integer, integer);
create function public.pending_documents(p_idle_minutes integer default 30, p_limit integer default null)
returns table(id uuid, session_key text, project_id uuid, turns integer, chars integer,
              last_turn_at timestamptz, consolidated_at timestamptz, consolidated_through bigint,
              repository text)
language sql stable security definer set search_path = '' as $$
  select d.id, d.session_key, d.project_id, d.turns, d.chars, d.last_turn_at,
         d.consolidated_at, d.consolidated_through, d.repository
  from public.documents d
  where d.owner_id = auth.uid()
    and d.last_turn_at < now() - make_interval(mins => greatest(coalesce(p_idle_minutes, 30), 0))
    and exists (
      select 1 from public.document_turns t
      where t.document_id = d.id
        and (d.consolidated_through is null or t.id > d.consolidated_through))
  order by d.last_turn_at
  limit case when p_limit is null then null else greatest(p_limit, 1) end;
$$;

revoke execute on function
  public.note_document_repository(text,text),
  public.pending_documents(integer,integer) from public, anon;
grant execute on function
  public.note_document_repository(text,text),
  public.pending_documents(integer,integer) to authenticated;

commit;
