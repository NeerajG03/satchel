begin;

-- slugify trimmed hyphens and then cut to 40 characters, so a title whose
-- 40th character was a hyphen produced a slug ending in one, which fails
-- tasks_slug_check. Every create_task inserts first and applies the supplied
-- slug second, so the derived slug is checked even when the agent sent a good
-- one. Confirmed on the live database on 23 September: "Design org-level
-- skills with user skill sync" became "design-org-level-skills-with-user-skill-"
-- and the create was refused, twice, with two different valid slugs.
--
-- Leading hyphens go first, then the cut, then the trailing trim. A title that
-- is all punctuation still falls back to 'item'.
create or replace function public.slugify(p_text text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(
    rtrim(substring(
      ltrim(regexp_replace(lower(btrim(p_text)), '[^a-z0-9]+', '-', 'g'), '-')
      from 1 for 40), '-'),
    ''), 'item');
$$;

commit;
