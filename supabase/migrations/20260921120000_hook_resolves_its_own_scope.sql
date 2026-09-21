begin;

-- The hint table existed because the bootstrap had no credential.
--
-- The plugin's local script could read the workspace's git origin but could not
-- authenticate, so it POSTed the repository name to an anonymous endpoint,
-- which staged a row, which the authenticated mcp_tool hook later consumed.
-- Two hops, a shared table, an expiry, and a 13x250ms poll in the consumer to
-- cover the race between them.
--
-- The hook scripts hold their own OAuth credential now, so the script that
-- knows the repository is also the caller that may resolve it. One call, no
-- staging, no race, no poll. This is that call.
--
-- agent_repository_hints and its functions stay: plugin versions before 0.3.0
-- are still installed and still use them, and an anonymous endpoint that
-- nothing calls is harmless where an endpoint that 404s mid-session is not.

-- Same rules as activate_agent_repository_hint, with the repository passed in
-- rather than read from a staged row.
--
--   one candidate    selected, and this is the common case
--   several          returned unselected, because picking one arbitrarily
--                    files a memory in a real project that is the wrong
--                    project, which is worse than leaving it personal
--   none             empty, and the caller stays in personal scope
--
-- security invoker: RLS on project_repositories already exposes only links
-- whose project this connection may read, which is what select_agent_repository
-- relies on too. The count is therefore per connection, so a repository shared
-- by two projects is still unambiguous to a grant that names one of them.
create or replace function public.resolve_agent_repository(
  p_session_key text, p_provider text, p_repository text)
returns table(project_id uuid, slug text, name text, brief text, selected boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  candidates uuid[];
  chosen uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select array_agg(r.project_id) into candidates
    from public.project_repositories r
    join public.projects p on p.id = r.project_id and p.owner_id = r.owner_id
    where r.owner_id = auth.uid()
      and r.provider = lower(btrim(p_provider))
      and r.repository = lower(btrim(p_repository));
  if candidates is null then return; end if;
  if array_length(candidates, 1) = 1 then
    chosen := candidates[1];
    perform public.select_agent_project(p_session_key, chosen);
  end if;
  -- coalesce, not a bare comparison. With nothing chosen, `p.id = chosen` is
  -- null rather than false, so every candidate came back with selected null and
  -- a caller checking `=== false` saw none of them as unselected. Caught by the
  -- SQL test rather than by reading it, which is the argument for having one.
  return query
    select p.id, p.slug, p.name, p.brief, coalesce(p.id = chosen, false)
    from public.projects p
    where p.id = any(candidates)
    order by p.name;
end;
$$;

revoke execute on function public.resolve_agent_repository(text, text, text) from public, anon;
grant execute on function public.resolve_agent_repository(text, text, text) to authenticated;

commit;
