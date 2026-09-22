begin;

-- Forgetting stops being destruction.
--
-- The database learned how to end a memory without destroying it, and the web
-- app did not. Its Forget button still ran a DELETE, which also took the row's
-- history with it, while the confirmation next to the button said "It leaves
-- active retrieval right away" — which is what ending does, not what deleting
-- does. The copy was describing the design and the code was doing something
-- else.
--
-- That matters more now than it did. Consolidation applies itself without
-- anyone watching, and the argument for letting it is that nothing it does is
-- destructive. A person whose own Forget button is the one irreversible act in
-- the system has the guarantee exactly backwards.
--
-- So Forget ends a memory, and coming back is a real act with a record rather
-- than an update nobody sees.
alter table public.memory_events drop constraint memory_events_action_check;
alter table public.memory_events add constraint memory_events_action_check
  check (action in ('added', 'corrected', 'confirmed', 'extended',
                    'replaced', 'retired', 'forgotten', 'restored'));

create or replace function private.record_memory_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  act text := private.memory_actor();
  trace text := nullif(current_setting('satchel.trace_id', true), '');
  doc uuid := nullif(current_setting('satchel.document_id', true), '')::uuid;
  note text := nullif(current_setting('satchel.reason', true), '');
  override text := nullif(current_setting('satchel.change', true), '');
  happened text;
begin
  if tg_op = 'INSERT' then
    insert into public.memory_events(owner_id, memory_id, action, after, actor, reason, trace_id, document_id)
      values (new.owner_id, new.id, 'added', new.statement, act, note, trace, doc);
    return new;
  end if;
  if new.ended_at is not null and old.ended_at is null then happened := new.ended_reason;
  -- Bringing one back is as much a change as ending it, and an undo that
  -- leaves no trace is the same missing record in the other direction.
  elsif new.ended_at is null and old.ended_at is not null then happened := 'restored';
  elsif new.statement is distinct from old.statement then
    happened := case when override = 'extended' then 'extended' else 'corrected' end;
  elsif new.band is distinct from old.band and new.band = 'said' then happened := 'confirmed';
  end if;
  if happened is null then return new; end if;
  insert into public.memory_events(owner_id, memory_id, action, before, after, actor, reason, trace_id, document_id)
    values (new.owner_id, new.id, happened, old.statement, new.statement, act, note, trace, doc);
  return new;
end;
$$;

/* Back into use.
 *
 * An expiry already past is cleared as well, because a row is archived for
 * either reason and "bring this back" cannot mean "bring it back into a state
 * where it is still hidden". A future expiry is left alone: that is a deadline
 * the person gave and restoring is not a reason to drop it. */
create function public.restore_memory(p_id uuid, p_revision integer)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  update public.memories
    set ended_at = null, ended_reason = null, ended_by = null, ended_note = null,
        expires_at = case when expires_at <= now() then null else expires_at end,
        affirmed_at = now()
    where id = p_id and revision = p_revision
      and (ended_at is not null or (expires_at is not null and expires_at <= now()))
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

revoke execute on function public.restore_memory(uuid,integer) from public, anon;
grant execute on function public.restore_memory(uuid,integer) to authenticated;

commit;
