begin;

-- Every waiting session is read, not the oldest ten.
--
-- pending_documents took a count and the pass asked for ten. On 22 September
-- the "Consolidate now" button read ten sessions in 26 of its 45 seconds and
-- stopped, and the three it left were the most recent ones, one of them
-- holding the clearest standing rule of the day. The count was never a
-- measure of anything: the clock already stops a batch that runs long, and
-- whatever it does not reach stays pending.
--
-- A null limit now means all of them, and it is the default, so a caller that
-- names no count gets every waiting session. `limit null` is Postgres for no
-- limit, which is why the old greatest(coalesce(...)) wrapper is gone rather
-- than rewritten. The grants are unchanged: create or replace keeps them.
create or replace function public.pending_documents(p_idle_minutes integer default 30, p_limit integer default null)
returns table(id uuid, session_key text, project_id uuid, turns integer, chars integer,
              last_turn_at timestamptz, consolidated_at timestamptz, consolidated_through bigint)
language sql stable security definer set search_path = '' as $$
  select d.id, d.session_key, d.project_id, d.turns, d.chars, d.last_turn_at,
         d.consolidated_at, d.consolidated_through
  from public.documents d
  where d.owner_id = auth.uid()
    and d.last_turn_at < now() - make_interval(mins => greatest(coalesce(p_idle_minutes, 30), 0))
    and exists (
      select 1 from public.document_turns t
      where t.document_id = d.id
        and (d.consolidated_through is null or t.id > d.consolidated_through))
  order by d.last_turn_at
  limit case when p_limit is null then null else greatest(p_limit, 1) end;
$$;

-- The scheduled job stops asking for ten. The body is 20260922170000's
-- exactly, which is the only migration that has defined it, with the one
-- argument removed.
create or replace function private.run_consolidation() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  row record;
  token text;
  request bigint;
  fired integer := 0;
begin
  -- Last tick's answers, before this tick's requests replace them.
  update public.consolidation_credentials c
    set last_status = r.status_code,
        last_error = case when r.status_code between 200 and 299 then null
                          else left(coalesce(r.error_msg, r.content, 'refused'), 500) end,
        failures = case when r.status_code between 200 and 299 then 0 else c.failures + 1 end,
        enabled = c.enabled and (r.status_code between 200 and 299 or c.failures + 1 < 3)
    from net._http_response r
    where r.id = c.last_request_id;

  for row in
    select c.*, s.decrypted_secret as refresh_token
    from public.consolidation_credentials c
    join vault.decrypted_secrets s on s.id = c.secret_id
    where c.enabled
      -- Not twice in one interval, even if a tick overlaps a slow run.
      and (c.last_run_at is null or c.last_run_at < now() - interval '5 hours')
      and exists (
        select 1 from public.documents d
        join public.document_turns t on t.document_id = d.id
        where d.owner_id = c.owner_id
          and d.last_turn_at < now() - make_interval(mins => c.idle_minutes)
          and (d.consolidated_through is null or t.id > d.consolidated_through))
  loop
    token := row.refresh_token;
    request := net.http_post(
      url => row.endpoint,
      headers => jsonb_build_object(
        'content-type', 'application/json',
        -- Not an Authorization header. This is a refresh token, not a bearer
        -- one, and the endpoint has to treat it as such: exchange it, use the
        -- access token it gets, and write the rotated one back.
        'x-satchel-refresh', token,
        'x-satchel-client', row.client_id),
      body => jsonb_build_object('idle_minutes', row.idle_minutes),
      timeout_milliseconds => 5000);
    -- Moved now rather than on success, so a failing endpoint is retried on
    -- the next interval instead of on the next tick. The request id is what
    -- the next tick reads the answer from.
    update public.consolidation_credentials
      set last_run_at = now(), last_request_id = request where owner_id = row.owner_id;
    fired := fired + 1;
  end loop;
  return fired;
end;
$$;

commit;
