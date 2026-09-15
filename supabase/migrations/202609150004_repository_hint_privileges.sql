begin;

-- Supabase may apply direct default EXECUTE grants in addition to PUBLIC.
-- The consumer must remain agent-authenticated; only staging is anonymous.
revoke execute on function public.activate_agent_repository_hint(text)
  from public, anon;

commit;
