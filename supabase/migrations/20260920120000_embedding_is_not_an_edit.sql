begin;

-- Embedding a memory is bookkeeping, not an edit, and the revision trigger did
-- not know the difference: it bumped the revision and moved updated_at on any
-- update at all. Backfilling the first two live memories took both of them from
-- revision 1 to revision 2 without a word of their text changing.
--
-- That is worse than untidy. The revision is the optimistic concurrency token,
-- so every client holding the old one gets a conflict it cannot explain, and
-- the person sees "edited just now" on a row nobody touched. Changing the
-- embedding model means re-embedding every row, which would do this to the
-- whole corpus at once.
--
-- The shape migration already had to disable this trigger around its own
-- backfill. That was a local patch for a general problem, so the rule moves
-- into the trigger where it covers every writer: a revision marks a change to
-- what the memory says or where it lives, and nothing else.
create or replace function public.stamp_memory_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.statement is not distinct from old.statement
    and new.source is not distinct from old.source
    and new.more_info is not distinct from old.more_info
    and new.name is not distinct from old.name
    and new.band is not distinct from old.band
    and new.project_id is not distinct from old.project_id
    and new.task_id is not distinct from old.task_id
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

commit;
