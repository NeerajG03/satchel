begin;

-- Listing your own conversations, for your own eyes.
--
-- documents and document_turns have no table grants at all, deliberately: an
-- agent connection is `authenticated` too, so a select grant would let any
-- connection read every session regardless of which projects it was given.
-- That is still true and still the right call.
--
-- What it leaves missing is the person. The developer view in the web app
-- needs to list what has been recorded, and the person sitting in their own
-- browser is the one caller who should see all of it. So this is a routine
-- rather than a grant, and it is closed to agents rather than open to
-- everything authenticated.
--
-- document_content() already reads the turns and is already owner-scoped, so
-- there is nothing new for the reading half. It stays callable by agents
-- because the consolidation pass is one.
create function public.recent_documents(p_limit integer default 50)
returns table(id uuid, session_key text, project_id uuid, project_slug text,
              turns integer, chars integer, started_at timestamptz, last_turn_at timestamptz,
              consolidated_at timestamptz, consolidated_through bigint,
              truncated_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  -- The same rule private.companion_only() applies to deleting: a person at
  -- their own browser, never a connection acting for them. Spelled out rather
  -- than borrowed, because that routine raises "Delete unavailable" and a
  -- message that describes the wrong action is worse than no message.
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
    order by d.last_turn_at desc
    limit greatest(coalesce(p_limit, 50), 1);
end;
$$;

revoke execute on function public.recent_documents(integer) from public, anon;
grant execute on function public.recent_documents(integer) to authenticated;

commit;
