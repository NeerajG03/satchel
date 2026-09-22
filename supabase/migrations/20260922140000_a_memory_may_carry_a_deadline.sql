begin;

-- An expiry the user actually stated.
--
-- The column has existed since 20260922110000 and nothing could set it, which
-- made it a column rather than a feature. "The freeze is on until the 30th" is
-- a real claim with a real end, and a memory set that still says it in October
-- is wrong in the way that is hardest to notice: it was true when it was
-- written.
--
-- Only ever from the user's own words. The source rule already forces that,
-- and there is no policy here inventing lifetimes for kinds: an expiry the
-- system guessed would end memories nobody agreed to end.
drop function public.capture_memory(uuid, text, text, text, text, text, uuid);
create function public.capture_memory(
  p_id uuid, p_statement text, p_source text, p_project_slug text default null,
  p_kind text default 'fact', p_trace text default null, p_document uuid default null,
  p_expires timestamptz default null
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target_project uuid;
  result public.memories;
begin
  perform private.attribute(p_trace, p_document, null);
  if p_project_slug is not null then
    select id into target_project from public.projects
      where owner_id = caller and slug = p_project_slug;
  end if;
  insert into public.memories(id, project_id, statement, source, band, kind, expires_at)
    values(p_id, target_project, btrim(p_statement), p_source, 'heard', p_kind,
           -- An expiry already in the past is a mistake, not an instruction to
           -- write something invisible. Dropped, so the memory is at least
           -- readable and deletable.
           case when p_expires > now() then p_expires end)
    on conflict(id) do nothing;
  select * into result from public.memories where id = p_id;
  if result.id is null
    or result.statement is distinct from btrim(p_statement)
    or result.kind is distinct from p_kind then
    raise exception 'Memory request conflict' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

revoke execute on function
  public.capture_memory(uuid,text,text,text,text,text,uuid,timestamptz) from public, anon;
grant execute on function
  public.capture_memory(uuid,text,text,text,text,text,uuid,timestamptz) to authenticated;

commit;
