begin;

-- The background pass, on a schedule the person sets.
--
-- Until now the job woke every six hours for anyone who had run a script on
-- their own machine. This makes it something a person switches on in Settings:
-- choose the days of the week, and one time a day or two, in their own time
-- zone. Twice is the most, because a pass is a model call over every waiting
-- conversation and a third one a day buys almost nothing.
--
--   days      0 to 6, Sunday is 0
--   times     one or two local times of day, at least an hour apart
--   timezone  an IANA name the browser reports
--
-- Defaults are every day at 02:00, which is the "overnight" in the name.
--
-- The script is gone, and with it the only caller that signed in as an app
-- client. So these routines now refuse any token that carries a client_id:
-- only the person's own browser session can turn the job on, off, retime it,
-- or read it. A connected app has no business changing when money is spent on
-- someone's behalf. rotate_consolidation_credential is not in that list: the
-- endpoint calls it as the job's own client after every run.

alter table public.consolidation_credentials
  add column days smallint[] not null default array[0,1,2,3,4,5,6]::smallint[]
    check (cardinality(days) between 1 and 7 and days <@ array[0,1,2,3,4,5,6]::smallint[]),
  add column times time[] not null default array['02:00'::time]
    check (cardinality(times) between 1 and 2),
  add column timezone text not null default 'UTC'
    check (length(timezone) <= 64 and timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$');

/* Only a person in their own browser. A signed-out caller is refused first,
 * the same way every other routine here does it. */
create function private.require_companion() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if ((select auth.jwt()) ->> 'client_id') is not null then
    raise exception 'Only you can change this, from the web app' using errcode = '42501';
  end if;
  return caller;
end;
$$;
revoke execute on function private.require_companion() from public, anon;
grant execute on function private.require_companion() to authenticated;

create function private.clean_days(p_days smallint[]) returns smallint[]
language sql immutable set search_path = '' as $$
  select (select array_agg(d order by d) from (select distinct d from unnest(p_days) d) q)
$$;

create function private.clean_times(p_times time[]) returns time[]
language sql immutable set search_path = '' as $$
  select (select array_agg(x order by x) from (
    select distinct make_time(extract(hour from t)::int, extract(minute from t)::int, 0) x
    from unnest(p_times) t) q)
$$;

/* What is wrong with a schedule, as a sentence, or null when nothing is. */
create function private.schedule_problem(p_days smallint[], p_times time[], p_timezone text) returns text
language plpgsql stable set search_path = '' as $$
declare gap interval;
begin
  if p_days is null or cardinality(p_days) not between 1 and 7
     or not (p_days <@ array[0,1,2,3,4,5,6]::smallint[]) then
    return 'Choose at least one day of the week.';
  end if;
  if p_times is null or cardinality(p_times) not between 1 and 2
     or exists (select 1 from unnest(p_times) t where t is null) then
    return 'Choose one time, or two at most.';
  end if;
  if cardinality(p_times) = 2 then
    gap := p_times[2] - p_times[1];
    if abs(extract(epoch from gap)) < 3600 or 86400 - abs(extract(epoch from gap)) < 3600 then
      return 'Two passes need to be at least an hour apart.';
    end if;
  end if;
  if p_timezone is null or p_timezone !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$' then
    return 'That time zone is not recognised.';
  end if;
  begin
    perform now() at time zone p_timezone;
  exception when others then
    return 'That time zone is not recognised.';
  end;
  return null;
end;
$$;

/* Is there a slot that should have fired by now and has not?
 *
 * Pure, with the clock as a parameter, so a test can ask about any moment. A
 * slot is today's or yesterday's local time of day (yesterday so a slot just
 * before midnight still counts after it), on a chosen weekday, in the past
 * but under three hours old, and after the last run. The last two are what
 * make a 15 minute tick safe: a slot fires once, and a database that was
 * down all night does not wake up and run a stale one at noon. */
create function private.consolidation_due(
  p_days smallint[], p_times time[], p_timezone text, p_last_run timestamptz,
  p_at timestamptz default now()
) returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1
    from unnest(p_times) as t(at_time)
    cross join generate_series(-1, 0) as back(n)
    cross join lateral (select (p_at at time zone p_timezone)::date + back.n as local_day) d
    cross join lateral (select (d.local_day + t.at_time) at time zone p_timezone as slot) s
    where extract(dow from d.local_day)::smallint = any(p_days)
      and s.slot <= p_at
      and s.slot > p_at - interval '3 hours'
      and (p_last_run is null or p_last_run < s.slot)
  )
$$;
revoke execute on function private.clean_days(smallint[]), private.clean_times(time[]),
  private.schedule_problem(smallint[], time[], text),
  private.consolidation_due(smallint[], time[], text, timestamptz, timestamptz)
  from public, anon, authenticated;

/* Turn it on. Called once, by the person, holding a token they just got from
 * a consent screen.
 *
 * The Vault is the whole reason this is security definer: nothing else may
 * write there, and nothing at all may read it back. */
drop function public.enable_consolidation(text, text, text, integer);
create function public.enable_consolidation(
  p_client_id text, p_refresh_token text, p_endpoint text, p_idle_minutes integer default 30,
  p_days smallint[] default null, p_times time[] default null, p_timezone text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := private.require_companion();
  name text;
  existing uuid;
  secret uuid;
  -- Only a missing argument takes the default. An empty list is a choice, and
  -- set_consolidation_schedule refuses it, so this must too.
  chosen_days smallint[] := case when p_days is null then array[0,1,2,3,4,5,6]::smallint[]
                                 else private.clean_days(p_days) end;
  chosen_times time[] := case when p_times is null then array['02:00'::time]
                              else private.clean_times(p_times) end;
  chosen_zone text := coalesce(p_timezone, 'UTC');
  problem text;
begin
  if coalesce(btrim(p_refresh_token), '') = '' then
    raise exception 'A refresh token is required' using errcode = '22023';
  end if;
  -- This is where the stored refresh token gets posted, so the browser does
  -- not get to name any URL it likes. Hosted, over https, and the one path.
  -- A localhost address could never be reached from the database anyway.
  if p_endpoint is null or p_endpoint !~ '^https://[^\s/?#@]+/api/consolidate$' then
    raise exception 'The overnight pass can only call this deployment over https.' using errcode = '22023';
  end if;
  problem := private.schedule_problem(chosen_days, chosen_times, chosen_zone);
  if problem is not null then raise exception '%', problem using errcode = '22023'; end if;
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
  insert into public.consolidation_credentials(owner_id, client_id, secret_id, endpoint, idle_minutes,
      days, times, timezone)
    values (caller, p_client_id, secret, p_endpoint, coalesce(p_idle_minutes, 30),
      chosen_days, chosen_times, chosen_zone)
    on conflict (owner_id) do update
      set client_id = excluded.client_id, secret_id = excluded.secret_id,
          endpoint = excluded.endpoint, idle_minutes = excluded.idle_minutes,
          days = excluded.days, times = excluded.times, timezone = excluded.timezone,
          enabled = true, failures = 0, last_error = null,
          -- A refusal from before the person signed in again is not about
          -- this credential, and must not count against it.
          last_request_id = null;
end;
$$;

/* Change when it runs, without signing in again. */
create function public.set_consolidation_schedule(p_days smallint[], p_times time[], p_timezone text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := private.require_companion();
  chosen_days smallint[] := private.clean_days(p_days);
  chosen_times time[] := private.clean_times(p_times);
  problem text;
begin
  problem := private.schedule_problem(chosen_days, chosen_times, p_timezone);
  if problem is not null then raise exception '%', problem using errcode = '22023'; end if;
  update public.consolidation_credentials
    set days = chosen_days, times = chosen_times, timezone = p_timezone
    where owner_id = caller;
  if not found then
    raise exception 'Switch the overnight pass on first.' using errcode = 'P0002';
  end if;
end;
$$;

/* Turn it off, and destroy the token. Revoking the connection in Apps stops
 * the job working; this is the other half, so the credential is gone rather
 * than merely useless. */
create or replace function public.disable_consolidation() returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion(); target uuid;
begin
  select secret_id into target from public.consolidation_credentials where owner_id = caller;
  delete from public.consolidation_credentials where owner_id = caller;
  if target is not null then delete from vault.secrets where id = target; end if;
end;
$$;

/* Everything about the job except the token, so a person can see whether it is
 * on, whether it is working, when it runs and whether the timer installed. */
drop function public.consolidation_status();
create function public.consolidation_status()
returns table(enabled boolean, endpoint text, idle_minutes integer,
              last_run_at timestamptz, last_status integer, last_error text,
              failures integer, scheduled boolean,
              days smallint[], times time[], timezone text, client_id text)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion(); job boolean := false;
begin
  begin
    execute 'select exists(select 1 from cron.job where jobname = $1)' into job using 'satchel-consolidate';
  exception when others then job := false;
  end;
  return query
    select c.enabled, c.endpoint, c.idle_minutes, c.last_run_at,
           c.last_status, c.last_error, c.failures, job,
           c.days, c.times, c.timezone, c.client_id
    from public.consolidation_credentials c where c.owner_id = caller;
end;
$$;

/* One tick, every 15 minutes. For every owner who turned this on, has a slot
 * that is due, and has a conversation nobody has read, post to their endpoint.
 *
 * The last condition is why an idle night costs nothing: a slot with nothing
 * to read does not call a model. It also means a conversation that goes quiet
 * an hour after the slot is still picked up, until the slot is three hours
 * old.
 *
 * The rest is as it was. Fire and forget, because pg_net is, so last tick's
 * answer is read at the start of this one, once, and three refusals in a row
 * (three requests, not three ticks) switch the credential off. */
create or replace function private.run_consolidation() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  row record;
  token text;
  request bigint;
  fired integer := 0;
begin
  update public.consolidation_credentials c
    set last_status = r.status_code,
        last_error = case when r.status_code between 200 and 299 then null
                          else left(coalesce(r.error_msg, r.content, 'refused'), 500) end,
        failures = case when r.status_code between 200 and 299 then 0 else c.failures + 1 end,
        enabled = c.enabled and (r.status_code between 200 and 299 or c.failures + 1 < 3),
        -- Read once. The response row stays in pg_net's log for hours and this
        -- runs every 15 minutes, so without this one refused request would be
        -- counted again on every tick and switch the job off in three of them.
        last_request_id = null
    from net._http_response r
    where r.id = c.last_request_id;

  for row in
    select c.*, s.decrypted_secret as refresh_token
    from public.consolidation_credentials c
    join vault.decrypted_secrets s on s.id = c.secret_id
    where c.enabled
      and private.consolidation_due(c.days, c.times, c.timezone, c.last_run_at)
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
        'x-satchel-refresh', token,
        'x-satchel-client', row.client_id),
      body => jsonb_build_object('idle_minutes', row.idle_minutes, 'limit', 10),
      timeout_milliseconds => 5000);
    -- Moved now rather than on success: a slot fires once. A failing endpoint
    -- is retried at the next slot, and the answer is read on the next tick.
    update public.consolidation_credentials
      set last_run_at = now(), last_request_id = request where owner_id = row.owner_id;
    fired := fired + 1;
  end loop;
  return fired;
end;
$$;

do $$
begin
  perform cron.unschedule('satchel-consolidate')
    where exists (select 1 from cron.job where jobname = 'satchel-consolidate');
  perform cron.schedule('satchel-consolidate', '*/15 * * * *',
    'select private.run_consolidation()');
exception when others then
  raise notice 'Satchel: consolidation schedule not installed (%)', sqlerrm;
end
$$;

revoke execute on function private.run_consolidation() from public, anon, authenticated;
revoke execute on function
  public.enable_consolidation(text,text,text,integer,smallint[],time[],text),
  public.set_consolidation_schedule(smallint[],time[],text),
  public.disable_consolidation(),
  public.consolidation_status() from public, anon;
grant execute on function
  public.enable_consolidation(text,text,text,integer,smallint[],time[],text),
  public.set_consolidation_schedule(smallint[],time[],text),
  public.disable_consolidation(),
  public.consolidation_status() to authenticated;
commit;
