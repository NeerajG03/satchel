begin;

-- A setting nobody can set is not a setting.
--
-- memory_settings has had per-column grants since it was created, and four
-- columns got them: gate, per_prompt_matches, scope_boost and
-- session_budget_tokens. Every column added afterwards was granted select and
-- nothing else, so `capture` and `capture_window` have been unwritable since
-- the router shipped, and `capture_mode`, `block_size` and
-- `staleness_commits` arrived the same way today.
--
-- It is not a small gap. capture_mode decides which of the two writers runs,
-- and with no way to change it the turn-by-turn router is the writer forever,
-- which is the one this whole rebuild exists to replace. The pass can be
-- triggered by hand and still nothing would stop the router saving the same
-- turns in its own words.
--
-- Column privileges, not a policy change. The policies are already right:
-- companion_memory_settings is ALL and agent_memory_settings_read is SELECT,
-- so an agent connection that tries to write finds no permissive policy and
-- is refused, exactly the way it already is for `gate`. This is the half that
-- was missing, and the reason it was missing is that a new column is not
-- writable until someone remembers to say so.
grant insert(capture, capture_window, capture_mode, block_size, staleness_commits),
      update(capture, capture_window, capture_mode, block_size, staleness_commits)
  on public.memory_settings to authenticated;

commit;
