begin;

-- Knowing which projects a codebase belongs to, without changing the scope.
--
-- The session-start block used to list every project the connection could
-- read, flat, with nothing saying which of them had anything to do with the
-- workspace you were sitting in. In cbx1/backend that reads as three equally
-- relevant projects when only two are linked there:
--
--   projects
--     data-model-2-0    linked to cbx1/backend
--     email-self-serve  linked to cbx1/backend
--     satchel           nothing to do with this codebase
--
-- To split that list the caller has to know the linked set. It already learns
-- it from resolve_agent_repository, but that function also selects, which is
-- fine on a fresh session and wrong after a /clear: the session key survives a
-- clear, so an explicit select_project made earlier is still active, and
-- re-resolving would quietly overwrite the scope the person chose.
--
-- So selection becomes a parameter. p_select false answers "which projects is
-- this repository linked to" and touches nothing.
--
-- Dropped and recreated rather than overloaded: a default argument makes a
-- second signature, and two functions of the same name differing only by an
-- optional tail is an ambiguity waiting for a caller to trip over.
drop function public.resolve_agent_repository(text, text, text);

create function public.resolve_agent_repository(
  p_session_key text, p_provider text, p_repository text, p_select boolean default true)
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
  -- One candidate still activates with no model involved and no tool call,
  -- which stays the common case. Several never does: filing a memory in a real
  -- project that is the wrong project is worse than leaving it personal, which
  -- is at least visibly unscoped.
  if p_select and array_length(candidates, 1) = 1 then
    chosen := candidates[1];
    perform public.select_agent_project(p_session_key, chosen);
  end if;
  -- coalesce, not a bare comparison. With nothing chosen, `p.id = chosen` is
  -- null rather than false, so every candidate came back with selected null and
  -- a caller checking `=== false` saw none of them as unselected.
  return query
    select p.id, p.slug, p.name, p.brief, coalesce(p.id = chosen, false)
    from public.projects p
    where p.id = any(candidates)
    order by p.name;
end;
$$;

revoke execute on function public.resolve_agent_repository(text, text, text, boolean) from public, anon;
grant execute on function public.resolve_agent_repository(text, text, text, boolean) to authenticated;

commit;
