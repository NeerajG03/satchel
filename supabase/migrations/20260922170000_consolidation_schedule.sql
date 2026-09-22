begin;

-- What runs the background pass, every six hours, with nobody at the keyboard.
--
-- The hard part is not the schedule, it is the credential. /api/consolidate
-- runs under RLS as a real person, which is R9's "isolation is enforced by the
-- database for every caller" and the thing that must not regress. pg_cron runs
-- inside the database and is nobody. Anything that hands a background job a
-- blanket key is the service role key wearing a different hat, so that is out.
--
-- So the owner grants the job its own connection, once, and the refresh token
-- for it lives in their own Vault:
--
--   scripts/enable-consolidation.mjs    one OAuth flow, its own client
--   vault                               the refresh token, encrypted at rest
--   consolidation_credentials           who is enabled, and nothing secret
--   cron  ->  private.run_consolidation ->  net.http_post  ->  /api/consolidate
--   the endpoint refreshes, acts as that person under RLS, writes the
--   rotated token back
--
-- Four properties this has to keep, and each one is a line of code below.
-- It is a separate OAuth client, so revoking it in Apps leaves the plugin's
-- connection alone and vice versa. Nothing but a definer function can read the
-- secret; no grant reaches it. The token is rotated on every use, which is
-- what Supabase does anyway and what breaks a stolen copy. And a refresh that
-- is refused disables the credential rather than retrying every six hours
-- forever, which it learns from pg_net's own response log rather than from
-- anyone telling it.

-- Who has enabled it. Deliberately holds nothing secret: the token is in the
-- Vault and this row only says that there is one.
create table public.consolidation_credentials (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  client_id text not null check (length(client_id) between 1 and 200),
  secret_id uuid not null,
  endpoint text not null check (endpoint ~ '^https?://[^\s]{1,300}$'),
  idle_minutes integer not null default 30 check (idle_minutes between 0 and 10080),
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_request_id bigint,
  last_status integer,
  last_error text check (length(last_error) <= 500),
  failures integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.consolidation_credentials enable row level security;
revoke all on public.consolidation_credentials from public, anon, authenticated;
-- No grants at all, not even select. The row names a Vault secret, and a
-- listing of who has one is not something an agent connection needs.

/* Turn it on. Called once, by the person, holding a token they just got from
 * a consent screen.
 *
 * The Vault is the whole reason this is security definer: nothing else may
 * write there, and nothing at all may read it back. */
create function public.enable_consolidation(
  p_client_id text, p_refresh_token text, p_endpoint text, p_idle_minutes integer default 30
) returns void language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  name text;
  existing uuid;
  secret uuid;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if coalesce(btrim(p_refresh_token), '') = '' then
    raise exception 'A refresh token is required' using errcode = '22023';
  end if;
  name := 'satchel_consolidation:' || caller::text;
  select c.secret_id into existing from public.consolidation_credentials c where c.owner_id = caller;
  if existing is not null then
    perform vault.update_secret(existing, p_refresh_token, name,
      'Satchel background consolidation, refreshed on every run');
    secret := existing;
  else
    secret := vault.create_secret(p_refresh_token, name,
      'Satchel background consolidation, refreshed on every run');
  end if;
  insert into public.consolidation_credentials(owner_id, client_id, secret_id, endpoint, idle_minutes)
    values (caller, p_client_id, secret, p_endpoint, coalesce(p_idle_minutes, 30))
    on conflict (owner_id) do update
      set client_id = excluded.client_id, secret_id = excluded.secret_id,
          endpoint = excluded.endpoint, idle_minutes = excluded.idle_minutes,
          enabled = true, failures = 0, last_error = null;
end;
$$;

/* The rotated token, written back by the endpoint after it refreshes.
 *
 * Supabase rotates on use, so without this the job works exactly once. It is
 * separate from enable_consolidation because it must not be able to turn
 * anything on, change the endpoint, or clear a failure count. */
create function public.rotate_consolidation_credential(p_refresh_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); target uuid;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if coalesce(btrim(p_refresh_token), '') = '' then return; end if;
  select secret_id into target from public.consolidation_credentials where owner_id = caller;
  if target is null then return; end if;
  perform vault.update_secret(target, p_refresh_token);
  update public.consolidation_credentials
    set last_run_at = now(), failures = 0, last_error = null where owner_id = caller;
end;
$$;

/* Turn it off, and destroy the token. Revoking the connection in Apps stops
 * the job working; this is the other half, so the credential is gone rather
 * than merely useless. */
create function public.disable_consolidation() returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); target uuid;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select secret_id into target from public.consolidation_credentials where owner_id = caller;
  delete from public.consolidation_credentials where owner_id = caller;
  if target is not null then delete from vault.secrets where id = target; end if;
end;
$$;

/* Everything about the job except the token, so a person can see whether it is
 * on, whether it is working, and whether the schedule actually installed. */
create function public.consolidation_status()
returns table(enabled boolean, endpoint text, idle_minutes integer,
              last_run_at timestamptz, last_status integer, last_error text,
              failures integer, scheduled boolean)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := auth.uid(); job boolean := false;
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  -- The schedule is installed by a guarded block below, because a project
  -- without pg_cron must not fail to deploy. That makes "did it install" a
  -- real question, so it is answerable.
  begin
    execute 'select exists(select 1 from cron.job where jobname = $1)' into job using 'satchel-consolidate';
  exception when others then job := false;
  end;
  return query
    select c.enabled, c.endpoint, c.idle_minutes, c.last_run_at,
           c.last_status, c.last_error, c.failures, job
    from public.consolidation_credentials c where c.owner_id = caller;
end;
$$;

/* One tick. For every owner who turned this on and has a conversation nobody
 * has read, post to their endpoint.
 *
 * Fire and forget, because pg_net is: the response lands in
 * net._http_response and nothing here waits for it. So the previous tick's
 * answer is read at the start of this one, which is where `failures` comes
 * from. Three refusals in a row and the credential is switched off, because a
 * revoked grant retried every six hours forever is noise nobody reads.
 *
 * Reading the log rather than being told is the point. The alternative was an
 * endpoint that reports its own failure, and a caller whose credential was
 * just refused has no session to report from, which would mean an
 * unauthenticated routine that can switch someone's job off. */
create function private.run_consolidation() returns integer
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
      body => jsonb_build_object('idle_minutes', row.idle_minutes, 'limit', 10),
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

do $$
begin
  execute 'create extension if not exists pg_cron';
  execute 'create extension if not exists pg_net';
  perform cron.unschedule('satchel-consolidate')
    where exists (select 1 from cron.job where jobname = 'satchel-consolidate');
  perform cron.schedule('satchel-consolidate', '17 */6 * * *',
    'select private.run_consolidation()');
exception when others then
  -- A project without pg_cron, or one where extensions are not ours to
  -- create, must still deploy. consolidation_status() reports `scheduled`
  -- false so this is visible rather than merely absent.
  raise notice 'Satchel: consolidation schedule not installed (%)', sqlerrm;
end
$$;

revoke execute on function private.run_consolidation() from public, anon, authenticated;
revoke execute on function
  public.enable_consolidation(text,text,text,integer),
  public.rotate_consolidation_credential(text),
  public.disable_consolidation(),
  public.consolidation_status() from public, anon;
grant execute on function
  public.enable_consolidation(text,text,text,integer),
  public.rotate_consolidation_credential(text),
  public.disable_consolidation(),
  public.consolidation_status() to authenticated;
commit;
