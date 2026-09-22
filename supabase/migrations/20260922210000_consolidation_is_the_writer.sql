begin;

-- Nothing writes a memory without reading the conversation first.
--
-- The turn-by-turn router has been the default writer since it shipped, and
-- it is the thing this rebuild exists to replace. It sees a five row window,
-- it is blind to everything already stored, and the only output it has is an
-- insert. Three of the eight memories in production on 21 September were
-- worth keeping, about six of twelve were deleted by hand within two days,
-- and today it captured a sentence out of a conversation about product
-- packaging while the consolidation pass read the same material and correctly
-- kept nothing.
--
-- `session` was always where this was going. It was not the default because
-- nothing called the pass, and switching before then would have meant no
-- capture at all. There is a button now, so that reason is gone.
--
-- Be clear about what this costs, because it is not nothing: with `session`
-- and no schedule, memory appears when someone asks for it and not before.
-- A conversation is still recorded either way, so nothing is lost and the
-- pass can read it whenever it runs. Capture that nobody asked for and
-- nobody can explain is worse than capture that waits.
alter table public.memory_settings alter column capture_mode set default 'session';

-- Anyone who never had a settings row was on the column default, so they move
-- with it. Anyone who has one and never chose is moved too: `turn` was never
-- a decision, it was the only option.
update public.memory_settings set capture_mode = 'session' where capture_mode = 'turn';

commit;
