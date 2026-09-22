begin;

-- When a memory was last said, shown to the pass that judges it.
--
-- R7. Nothing had a temporal anchor of any kind, which is why the live
-- personal memory reads "do not include names of people who are not in the
-- review list this time around": a relative reference frozen into a permanent
-- claim. A model cannot resolve "last week" without being told what week it
-- is, and it cannot doubt a claim without being told how old it is.
--
-- affirmed_at rather than updated_at, because they answer different questions.
-- updated_at is the last time the wording changed; affirmed_at is the last
-- time anyone said the thing again, which is what age means here.
drop function public.memories_in_scope(uuid, integer);
create function public.memories_in_scope(p_project_id uuid default null, p_limit integer default 60)
returns table(id uuid, project_id uuid, project_slug text, statement text, band text,
              kind text, mentions integer, revision integer,
              affirmed_at timestamptz, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, p.slug, m.statement, m.band,
         m.kind, m.mentions, m.revision, m.affirmed_at, m.updated_at
  from public.memories m
  left join public.projects p on p.id = m.project_id
  where (m.project_id is null or m.project_id = p_project_id)
    and m.ended_at is null
    and (m.expires_at is null or m.expires_at > now())
  order by m.project_id nulls first, m.updated_at desc, m.id
  limit greatest(coalesce(p_limit, 60), 1);
$$;

-- Saying a thing again is one of the outcomes now, so the run log counts it.
-- Without it a pass that spent a call confirming three memories reads in the
-- log exactly like one that did nothing.
alter table public.consolidation_runs add column affirmed integer not null default 0;
grant insert(affirmed) on public.consolidation_runs to authenticated;

revoke execute on function public.memories_in_scope(uuid,integer) from public, anon;
grant execute on function public.memories_in_scope(uuid,integer) to authenticated;

commit;
