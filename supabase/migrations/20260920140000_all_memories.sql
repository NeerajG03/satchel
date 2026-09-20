begin;

-- The 1.0 web UI searches across every scope at once, which list_memories
-- cannot do: it takes one scope and personal is a scope like any other.
--
-- It needs its own routine rather than a plain select from the table, because
-- the index carries a flag and never the detail. A client that selected
-- more_info to work out whether there is any would pull up to 40,000
-- characters per row into the browser to render a chevron, which is the exact
-- thing list_memories exists to avoid.
--
-- Security invoker, so the existing row policies decide what "every scope you
-- own" actually means.
create function public.all_memories()
returns table(id uuid, project_id uuid, statement text, band text, task_id uuid,
  name text, has_more_info boolean, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, m.statement, m.band, m.task_id, m.name,
    length(btrim(m.more_info)) > 0, m.revision, m.updated_at
  from public.memories m
  order by m.updated_at desc, m.id;
$$;

revoke execute on function public.all_memories() from public, anon;
grant execute on function public.all_memories() to authenticated;

commit;
