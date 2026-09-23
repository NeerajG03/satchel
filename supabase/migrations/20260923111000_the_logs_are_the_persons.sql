begin;

-- The three logs that hold what people said are for the person, not for the
-- apps they connected.
--
-- An agent token is `authenticated` and its `sub` is the owner, so a plain
-- owner policy let any connection read these through PostgREST with its own
-- token and the publishable key, whatever its grant said:
--
--   consolidation_runs.prompt   a whole session, plus memories from every scope
--   router_runs.prompt          the capture window, which is the conversation
--   memory_injections.query     the prompt the person typed
--
-- documents and document_turns have no grants at all for exactly this reason,
-- and recent_documents refuses any token with a client_id. These three were
-- the same text by a side door.
--
-- The person's browser session carries no client_id, so it still reads all of
-- it, which is what the developer Activity page needs.
--
-- Writes are unchanged. The server logs as whoever called it, the hook's
-- connection or the cron's, so the insert policies still take agent tokens.

drop policy owner_reads_consolidation_runs on public.consolidation_runs;
create policy owner_reads_consolidation_runs on public.consolidation_runs
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt()) ->> 'client_id') is null);

drop policy owner_reads_injections on public.memory_injections;
create policy owner_reads_injections on public.memory_injections
  for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt()) ->> 'client_id') is null);

-- router_runs has one reader that is not the browser. capturedThisSession
-- reads the statements the router already produced in this session, under the
-- hook's own token, so the router is not told to say them again. Browser-only
-- would make that read come back empty without an error, and capture would
-- start saving the same thing twice.
--
-- So a connection reads back the rows it wrote, and nothing else. Which
-- connection wrote a row is filled in from the token by the database, and the
-- column is not in the insert grant, so it cannot be claimed. Rows written
-- before this have no client_id and are the browser's alone.
alter table public.router_runs
  add column client_id text default (auth.jwt() ->> 'client_id')
    check (length(client_id) <= 200);

drop policy owner_reads_router_runs on public.router_runs;
create policy owner_reads_router_runs on public.router_runs
  for select to authenticated
  using (owner_id = (select auth.uid()) and (
    ((select auth.jwt()) ->> 'client_id') is null
    or client_id = ((select auth.jwt()) ->> 'client_id')));

commit;
