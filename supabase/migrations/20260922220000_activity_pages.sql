begin;

-- The developer feed reads a page at a time.
--
-- It asked every source for its newest 40 and rendered the lot, which is two
-- problems wearing one coat. The smaller one is the row count. The larger one
-- is that `router_runs.prompt` and `consolidation_runs.prompt` are whole model
-- prompts, capped at 40,000 and 200,000 characters, and the list was selecting
-- both of them to render a line that says "kept 0, dropped 0". On this
-- database that is already 939 KB across 123 router runs, and a Stop hook
-- writes another every turn.
--
-- That is the exact mistake list_memories was written to prevent: a client
-- pulling the long column to decide whether to draw a chevron. The columns
-- move to a read on open, where document turns already were, and the rest of
-- the feed pages by time.
--
-- Paging by timestamp rather than by offset, because the feed is a merge of
-- six sources. An offset into a merged list means nothing when each source is
-- fetched separately, and rows arrive while you read.
drop function public.recent_documents(integer);
create function public.recent_documents(p_limit integer default 50, p_before timestamptz default null)
returns table(id uuid, session_key text, project_id uuid, project_slug text,
              turns integer, chars integer, started_at timestamptz, last_turn_at timestamptz,
              consolidated_at timestamptz, consolidated_through bigint,
              truncated_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null or ((select auth.jwt())->>'client_id') is not null then
    raise exception 'Your conversations are readable from your own session only'
      using errcode = '42501';
  end if;
  return query
    select d.id, d.session_key, d.project_id, p.slug, d.turns, d.chars,
           d.started_at, d.last_turn_at, d.consolidated_at, d.consolidated_through,
           d.truncated_at, d.expires_at
    from public.documents d
    left join public.projects p on p.id = d.project_id
    where d.owner_id = caller
      -- Inclusive, and the caller drops what it has already seen. The cursor
      -- is a moment rather than a row, and two sources can land on the same
      -- microsecond; excluding the boundary would silently skip whichever one
      -- did not make the previous page.
      and (p_before is null or d.last_turn_at <= p_before)
    order by d.last_turn_at desc
    limit greatest(coalesce(p_limit, 50), 1);
end;
$$;

revoke execute on function public.recent_documents(integer,timestamptz) from public, anon;
grant execute on function public.recent_documents(integer,timestamptz) to authenticated;

commit;
