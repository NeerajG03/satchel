begin;

-- The reply check: ask the agent to rewrite a reply once when it breaks the
-- person's own preferences. Off until they switch it on, because it changes
-- what the agent does at the end of every turn.
--
-- The limit is words in the reply the person reads, with code blocks left
-- out. The range keeps a typo from setting it to something that either
-- rewrites every reply or never rewrites one.
alter table public.memory_settings
  add column reply_check boolean not null default false,
  add column reply_word_limit integer not null default 200
    check (reply_word_limit between 50 and 2000);

-- A new column is not writable until someone says so. The policies already
-- keep an agent connection out: it may read settings and never change them.
grant insert(reply_check, reply_word_limit), update(reply_check, reply_word_limit)
  on public.memory_settings to authenticated;

commit;
