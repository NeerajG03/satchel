begin;

-- The turn a capture classifies is now a boundary rather than a guess.
--
-- capture_window is 5 and the Stop handler used that one number for two jobs:
-- how many rows to fetch, and how many trailing user messages count as "the
-- turn". So every Stop re-classified the last five user messages. Consecutive
-- Stops overlapped by four, and anything durable got offered to the router five
-- times. It was taken twice, thirty-six seconds apart, in two wordings:
--
--   "A paid key has been added to Vercel instead of the free one, so limits
--    should be much more generous."
--   "A paid key was added to Vercel instead of the free one, so the limits are
--    more generous."
--
-- A message is now marked when it has been classified, and the turn is exactly
-- what has not been. That is a boundary and not a heuristic: it survives queued
-- messages, it survives a host that records no assistant reply (Codex has no
-- last_assistant_message, so its window is user rows only and there is no
-- alternating pattern to infer a turn from), and it cannot drift.

alter table public.session_messages add column classified_at timestamptz;

-- The read side asks "what has not been classified", so the partial index is
-- the whole access pattern and it shrinks as rows are marked.
create index session_messages_unclassified
  on public.session_messages(owner_id, session_key, id)
  where classified_at is null;

-- Recreated rather than replaced: the return type gains two columns and
-- Postgres will not replace a function with a different one. Only
-- 20260920110000_router.sql has ever defined this, checked rather than assumed,
-- because recreating a function has silently reverted an earlier migration in
-- this repo before.
drop function public.session_window(text, integer);
create function public.session_window(p_session_key text, p_limit integer default 12)
returns table(id bigint, role text, content text, created_at timestamptz, classified_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.id, m.role, m.content, m.created_at, m.classified_at
  from public.session_messages m
  where m.owner_id = auth.uid() and m.session_key = p_session_key
  order by m.id desc
  limit greatest(p_limit, 1);
$$;

-- Marked only after the router has actually answered. A run that failed on a
-- rate limit leaves its messages unclassified so the next turn picks them up,
-- and a run that answered with an empty list still marks, because "nothing here
-- is worth keeping" is a real answer and asking again would not change it.
create function public.mark_session_classified(p_session_key text, p_through bigint)
returns integer language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); marked integer;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.session_messages m set classified_at = now()
    where m.owner_id = caller and m.session_key = p_session_key
      and m.id <= p_through and m.classified_at is null;
  get diagnostics marked = row_count;
  return marked;
end;
$$;

revoke execute on function
  public.session_window(text,integer),
  public.mark_session_classified(text,bigint) from public, anon;
grant execute on function
  public.session_window(text,integer),
  public.mark_session_classified(text,bigint) to authenticated;

commit;
