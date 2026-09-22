begin;

-- What loads into a session is capped.
--
-- R3, and the one place Satchel deliberately does something supermemory does
-- not. Supermemory's graph is unbounded and retrieval ranks it. Our own eval
-- says the opposite for the slice that matters most: on personal memory,
-- loading the set whole scores nDCG 0.772 against retrieval's 0.174. A set
-- that loads whole has to be small, and small has to be a number.
--
-- Thirty per scope. The cap is not a limitation, it is the mechanism:
--
--   it turns extraction from an absolute question, "is this durable forever",
--   which the old 2000 word prompt still got wrong, into a comparative one,
--   "is this worth more than the weakest line already in the block", which a
--   small model can actually answer
--
--   it keeps the set small enough for a person to read, which is what owning
--   your own memory actually requires
--
-- Nothing is destroyed by the cap and nothing is ended by it. A memory past
-- the cap stays live and stays searchable; it is simply not injected. Ending a
-- rule for being old would be the worst possible reading of "bounded".
alter table public.memory_settings
  add column block_size integer not null default 30
    check (block_size between 5 and 200);

-- Rank, so "the weakest line" is a fact rather than an opinion.
--
-- Repetition first, because a claim restated across sessions is the strongest
-- evidence we have and it is free. Then recency of being said, not of being
-- edited: affirmed_at is the last time anyone meant it.
drop function public.personal_memories();
create function public.personal_memories()
returns table(id uuid, statement text, band text, kind text, mentions integer,
              affirmed_at timestamptz, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.statement, m.band, m.kind, m.mentions, m.affirmed_at, m.updated_at
  from public.memories m
  where m.project_id is null
    and m.ended_at is null
    and (m.expires_at is null or m.expires_at > now())
  order by m.mentions desc, m.affirmed_at desc, m.updated_at desc, m.id;
$$;

revoke execute on function public.personal_memories() from public, anon;
grant execute on function public.personal_memories() to authenticated;

commit;
