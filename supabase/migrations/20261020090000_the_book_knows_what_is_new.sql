begin;

-- The book shows what came in since you last looked, and why each row moved.
-- updated_at alone cannot say that: it is the last time the wording changed,
-- so a new memory and a corrected one look the same, and a memory said again
-- does not move at all because only affirmed_at changes.
--
-- The last memory_events row says what the last real change was (added,
-- corrected, confirmed and so on), and affirmed_at past that event means it
-- was only said again since, which writes no event.
--
-- Only all_memories carries these. list_memories is what an agent's
-- memory_index returns row for row, and an agent has no use for them.

drop function public.all_memories();

CREATE OR REPLACE FUNCTION public.all_memories()
 RETURNS TABLE(id uuid, topic_id uuid, statement text, band text, kind text, name text, has_more_info boolean, mentions integer, revision integer, updated_at timestamp with time zone, created_at timestamp with time zone, affirmed_at timestamp with time zone, last_change text, last_change_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select m.id, m.topic_id, m.statement, m.band, m.kind, m.name,
    length(btrim(m.more_info)) > 0, m.mentions, m.revision, m.updated_at,
    m.created_at, m.affirmed_at, e.action, e.created_at
  from public.memories m
  left join lateral (
    select ev.action, ev.created_at from public.memory_events ev
    where ev.memory_id = m.id
    order by ev.created_at desc, ev.id desc
    limit 1
  ) e on true
  where m.ended_at is null
    and (m.expires_at is null or m.expires_at > now())
  order by m.updated_at desc, m.id;
$function$;

revoke all on function public.all_memories() from public, anon, authenticated;
grant execute on function public.all_memories() to authenticated;
do $grants$ begin if exists (select 1 from pg_roles where rolname = 'service_role') then
  execute 'grant execute on function public.all_memories() to service_role';
end if; end $grants$;

commit;
