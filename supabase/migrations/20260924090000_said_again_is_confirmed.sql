begin;

-- Saying it again confirms it.
--
-- A heard memory used to need a person: the Correct button, or telling an
-- agent "yes, that's right" so it would call confirm_memory. Neither happened
-- in practice, and memory is meant to look after itself, so nothing Satchel
-- learned on its own ever became confirmed.
--
-- A pass affirms or extends a memory only when the person restated it, in
-- turns the pass had not read before, with their words copied as the source.
-- That is the agreement a confirm button would have asked for, given without
-- being asked. So both now move the row to `said`, and the history trigger
-- records it as `confirmed`, with the trace and the conversation that did it.
--
-- Nothing is backfilled. Every personal memory loads at session start now
-- whatever its band, so a heard row waiting for its next mention loses
-- nothing, and the history stays a record of what actually happened.

create or replace function public.extend_memory(
  p_id uuid, p_revision integer, p_statement text,
  p_trace text default null, p_document uuid default null
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  perform private.attribute(p_trace, p_document, null);
  perform set_config('satchel.change', 'extended', true);
  update public.memories
    set statement = btrim(p_statement), affirmed_at = now(), mentions = mentions + 1, band = 'said'
    where id = p_id and revision = p_revision and ended_at is null
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

-- A new signature, because the confirm it can now cause is an event, and an
-- event without the conversation behind it is the missing record the
-- attribution exists to prevent.
drop function public.affirm_memory(uuid);
create function public.affirm_memory(p_id uuid, p_trace text default null, p_document uuid default null)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  perform private.attribute(p_trace, p_document, null);
  update public.memories set affirmed_at = now(), mentions = mentions + 1, band = 'said'
    where id = p_id and ended_at is null returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;
revoke execute on function public.affirm_memory(uuid,text,uuid) from public, anon;
grant execute on function public.affirm_memory(uuid,text,uuid) to authenticated;

commit;
