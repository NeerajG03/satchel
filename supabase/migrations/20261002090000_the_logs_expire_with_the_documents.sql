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
-- the decisions on them are what the review reads. Only the text goes, and it
-- goes on the same clock as the document it came from, from the same routine,
-- so there is one retention and one place it is enforced.
begin;

create or replace function public.expire_documents() returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  delete from public.documents where expires_at < now();
  get diagnostics removed = row_count;
  update public.consolidation_runs
    set prompt = '(expired)', response = null
    where created_at < now() - interval '30 days' and prompt <> '(expired)';
  update public.router_runs
    set prompt = '(expired)', response = null
    where created_at < now() - interval '30 days' and prompt <> '(expired)';
  update public.memory_injections
    set query = null
    where created_at < now() - interval '30 days' and query is not null;
  return removed;
end;
$$;
revoke execute on function public.expire_documents() from public, anon;
grant execute on function public.expire_documents() to authenticated;

commit;
