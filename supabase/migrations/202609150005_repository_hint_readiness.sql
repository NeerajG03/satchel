begin;

-- Hook handlers may start concurrently. This authenticated readiness probe lets
-- the MCP handler wait briefly for the local bootstrap without exposing hint
-- contents or accepting a project choice from the client.
create function public.agent_repository_hint_exists(p_session_key text)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.agent_connection_status() is null then
    raise exception 'Connection unavailable' using errcode = '42501';
  end if;
  return exists(
    select 1 from public.agent_repository_hints
      where session_key = p_session_key and expires_at >= now()
  );
end;
$$;

revoke execute on function public.agent_repository_hint_exists(text)
  from public, anon;
grant execute on function public.agent_repository_hint_exists(text)
  to authenticated;

commit;
