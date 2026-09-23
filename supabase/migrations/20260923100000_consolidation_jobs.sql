begin;

-- A consolidation you start and come back to.
--
-- The button used to be one request: read what it could in 45 seconds, then
-- answer. On 22 September that meant a person watching a spinner for half a
-- minute and then being told to press again. And the cron's request gave up
-- after pg_net's five seconds, so its answer was a timeout every time, even
-- when the pass ran fine behind it.
--
-- So pressing the button now starts a job and returns at once. The job runs as
-- a chain of short calls, each reading for about four minutes and then handing
-- on to the next, for up to 30 minutes in all. This row is how far it got, and
-- when it stops it is the report.
--
--   step          which call in the chain holds the job. A call claims the next
--                 step before it starts reading, and only one claim can win, so
--                 a "carry on" pressed while the chain is still alive does not
--                 read the same session twice.
--   heartbeat_at  moved after every document. A running job whose heartbeat
--                 is a few minutes old has lost its chain, and the page offers
--                 to carry on rather than showing a spinner forever.
--   runs          one entry per session read: what it did, and each change
--                 with the model's reason. This is what the page shows.
create table public.consolidation_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'finished', 'stopped')),
  stop_reason text check (length(stop_reason) <= 500),
  idle_minutes integer not null default 30 check (idle_minutes between 0 and 10080),
  started_at timestamptz not null default now(),
  -- Fixed at the start, and not updatable. The wall is the job's, not the
  -- call's: however many calls it takes, it ends 30 minutes after it began.
  deadline_at timestamptz not null default now() + interval '30 minutes',
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  step integer not null default 0 check (step >= 0),
  waiting integer not null default 0 check (waiting >= 0),
  read integer not null default 0 check (read >= 0),
  added integer not null default 0,
  extended integer not null default 0,
  replaced integer not null default 0,
  retired integer not null default 0,
  affirmed integer not null default 0,
  dropped integer not null default 0,
  failed integer not null default 0,
  runs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(runs) = 'array' and octet_length(runs::text) <= 400000)
);
-- One at a time per person. Two jobs over the same waiting sessions would
-- read each of them twice and affirm every memory in them twice.
create unique index consolidation_jobs_one_running
  on public.consolidation_jobs(owner_id) where status = 'running';
create index consolidation_jobs_owner_started
  on public.consolidation_jobs(owner_id, started_at desc);

/* Who may hold a job: the person in their own browser, or the one app that is
 * the schedule. Not any app they connected.
 *
 * The report names memories from every scope the pass read, personal and
 * every project. An agent connection is `authenticated` and owned by the same
 * person, so a plain owner policy would let a connection granted one project
 * read what the pass decided about all the others. The cron's client is the
 * exception because it is the job: its id is on the owner's credential row,
 * which this reads as definer since that table has no grants at all. */
create function private.may_hold_consolidation_job() returns boolean
language sql stable security definer set search_path = '' as $$
  select ((select auth.jwt()) ->> 'client_id') is null
    or exists (select 1 from public.consolidation_credentials c
               where c.owner_id = (select auth.uid())
                 and c.client_id = (select auth.jwt()) ->> 'client_id');
$$;
revoke execute on function private.may_hold_consolidation_job() from public, anon;
grant execute on function private.may_hold_consolidation_job() to authenticated;

alter table public.consolidation_jobs enable row level security;
revoke all on public.consolidation_jobs from public, anon, authenticated;
grant select on public.consolidation_jobs to authenticated;
-- Column by column, the same as consolidation_runs. owner_id, started_at and
-- deadline_at are set by their defaults and nothing may move them afterwards.
grant insert(idle_minutes, waiting) on public.consolidation_jobs to authenticated;
grant update(status, stop_reason, heartbeat_at, finished_at, step, read,
  added, extended, replaced, retired, affirmed, dropped, failed, runs)
  on public.consolidation_jobs to authenticated;
create policy owner_reads_consolidation_jobs on public.consolidation_jobs
  for select to authenticated
  using (owner_id = (select auth.uid()) and (select private.may_hold_consolidation_job()));
create policy owner_starts_consolidation_jobs on public.consolidation_jobs
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select private.may_hold_consolidation_job()));
create policy owner_moves_consolidation_jobs on public.consolidation_jobs
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select private.may_hold_consolidation_job()))
  with check (owner_id = (select auth.uid()));

commit;
