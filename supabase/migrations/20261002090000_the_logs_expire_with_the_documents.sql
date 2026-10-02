-- The conversation text kept beside the documents expires with them.
--
-- The 30 day promise was made about documents, and expire_documents() keeps
-- it. But three other tables hold the same words with no end: a consolidation
-- run keeps the whole prompt it sent, which is the conversation; a router run
-- keeps its window; and an injection log keeps the user's prompt as the query.
-- None of them had a delete, so the oldest conversation in the system was not
-- 30 days old, it was as old as the first run.
--
-- The rows stay. They are the audit trail, and the counts, the trace id and
-- the decisions on them are what the review reads. Only the text goes, on the
-- same 30 day clock as the document it came from.
--
-- A routine of its own rather than a line in expire_documents(), because that
-- one runs inside record_turn on every prompt, behind the hook's budget. This
-- is called by the consolidation job once a step, where three table scans
-- cost nothing anyone is waiting on. A run that never reached the model keeps
-- its '(not sent)' marker, which is the signal that tells it from one that did.
begin;

create index if not exists consolidation_runs_created on public.consolidation_runs(created_at);
create index if not exists router_runs_created on public.router_runs(created_at);

create function public.expire_run_logs() returns integer
language plpgsql security definer set search_path = '' as $$
declare blanked integer := 0;
        n integer;
begin
  update public.consolidation_runs
    set prompt = '(expired)', response = null
    where created_at < now() - interval '30 days'
      and prompt not in ('(expired)', '(not sent)');
  get diagnostics n = row_count; blanked := blanked + n;
  update public.router_runs
    set prompt = '(expired)', response = null
    where created_at < now() - interval '30 days'
      and prompt not in ('(expired)', '(not sent)');
  get diagnostics n = row_count; blanked := blanked + n;
  update public.memory_injections
    set query = null
    where created_at < now() - interval '30 days' and query is not null;
  get diagnostics n = row_count; blanked := blanked + n;
  return blanked;
end;
$$;
revoke execute on function public.expire_run_logs() from public, anon;
grant execute on function public.expire_run_logs() to authenticated;

commit;
