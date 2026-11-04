begin;

-- A connected app (Claude Code, Codex) can be allowed the Shelf: search what
-- was dropped, read the lists Satchel made (Books, Expenses, Good to know),
-- and drop a typed note that is then read and sorted like any other. It never
-- sees a photo or voice file, never removes, ticks or moves anything, and
-- never reaches Google. Both profiles, as the person chose. Off unless the
-- consent page turned it on; it is part of the grant, so revoking or
-- re-consenting ends it with everything else.

alter table public.agent_connections add column shelf boolean not null default false;
-- Who put a drop on the Shelf: null for the person, an app's name for an app.
alter table public.shelf_items add column added_by text check (char_length(added_by) <= 100);

create function public.authorize_agent_v5(p_client_id text, p_label text, p_personal boolean, p_all_topics boolean,
  p_topic_ids uuid[], p_can_write boolean, p_shelf boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.authorize_agent_v4(p_client_id, p_label, p_personal, p_all_topics, p_topic_ids, p_can_write);
  update public.agent_connections c set shelf = coalesce(p_shelf, false)
  where c.owner_id = auth.uid() and c.client_id = p_client_id;
end;
$$;


create or replace function public.agent_connection_status()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'client_id', c.client_id,
    'label', c.label,
    'personal', c.personal,
    'all_topics', c.all_topics,
    'topic_ids', c.topic_ids,
    'can_write', c.can_write,
    'shelf', c.shelf
  )
  from public.agent_connections c
  where c.owner_id = auth.uid()
    and c.client_id = auth.jwt()->>'client_id'
    and c.grant_id::text = auth.jwt()->>'satchel_grant_id'
    and c.revoked_at is null;
$$;

-- The Shelf page says which drops an app made, and reads them when it opens.
drop function public.list_shelf_items(integer);
create function public.list_shelf_items(p_limit integer default 60)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz, profile text, transcript text, sorted_at timestamptz,
  topic_id uuid, topic_name text, voice_path text, added_by text)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at,
      s.profile, s.transcript, s.sorted_at, coalesce(m.id, t.id), coalesce(m.name, t.name), s.voice_path, s.added_by
    from public.shelf_items s
    left join public.topics t on t.id = s.topic_id and t.owner_id = caller
    left join public.topics m on m.id = t.merged_into and m.owner_id = caller
    where s.owner_id = caller
    order by s.created_at desc, s.id limit least(greatest(coalesce(p_limit, 60), 1), 200);
end;
$$;

-- The server's reads of one item say whether an app added it: an app's words
-- are sorted like any drop but never sent on to memory as the person's own.
drop function public.claim_shelf_item(uuid);
create function public.claim_shelf_item(p_id uuid)
returns table(id uuid, kind text, note text, object_path text, mime_type text, size_bytes integer,
  voice_path text, voice_mime text, voice_size integer, added_by text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query with taken as (
    update public.shelf_items s set status = 'reading', claimed_at = now()
    where s.id = p_id and s.owner_id = caller
      and (s.status in ('waiting','failed') or (s.status = 'reading' and s.claimed_at < now() - interval '2 minutes'))
    returning s.id, s.kind, s.note, s.object_path, s.mime_type, s.size_bytes, s.voice_path, s.voice_mime, s.voice_size, s.added_by)
  select taken.id, taken.kind, taken.note, taken.object_path, taken.mime_type, taken.size_bytes,
    taken.voice_path, taken.voice_mime, taken.voice_size, taken.added_by from taken;
  if not found then
    if exists (select 1 from public.shelf_items s where s.id = p_id and s.owner_id = caller) then
      raise exception 'That shelf item is already read or being read' using errcode = '55000', hint = 'satchel:conflict:shelf_reading';
    end if;
    raise exception 'That shelf item is gone' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
end;
$$;

drop function public.read_shelf_item(uuid);
create function public.read_shelf_item(p_id uuid)
returns table(id uuid, kind text, note text, object_path text, mime_type text, size_bytes integer,
  description text, transcript text, status text, sorted_at timestamptz,
  voice_path text, voice_mime text, voice_size integer, wants_at timestamptz, added_by text)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.size_bytes, s.description, s.transcript,
      s.status, s.sorted_at, s.voice_path, s.voice_mime, s.voice_size, s.wants_at, s.added_by
    from public.shelf_items s where s.id = p_id and s.owner_id = caller;
end;
$$;

-- The app's owner, when this token is a live grant that includes the Shelf.
create function private.shelf_app() returns table(owner_id uuid, label text)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query select c.owner_id, c.label from public.agent_connections c
    where c.owner_id = auth.uid() and c.client_id = auth.jwt()->>'client_id'
      and c.grant_id::text = auth.jwt()->>'satchel_grant_id' and c.revoked_at is null and c.shelf;
  if not found then
    raise exception 'This connection was not allowed the Shelf' using errcode = '42501', hint = 'satchel:refused:shelf';
  end if;
end;
$$;

-- Search by meaning, as the Shelf page does. Words only: what was typed or
-- said and Satchel's reading of a photo, never the file.
create function public.agent_search_shelf(p_query extensions.vector, p_model text,
  p_limit integer default 10, p_gate real default 0.63)
returns table(id uuid, kind text, note text, transcript text, description text, topic_name text, profile text,
  created_at timestamptz, similarity real)
language plpgsql stable security definer set search_path = '' as $$
declare owner uuid;
begin
  select a.owner_id into owner from private.shelf_app() a;
  return query select s.id, s.kind, s.note, left(s.transcript, 2000), left(s.description, 2000),
      coalesce(m.name, t.name), s.profile, s.created_at, (1 - (s.embedding operator(extensions.<=>) p_query))::real
    from public.shelf_items s
    left join public.topics t on t.id = s.topic_id and t.owner_id = owner
    left join public.topics m on m.id = t.merged_into and m.owner_id = owner
    where s.owner_id = owner and s.status = 'ready' and s.embedding_model = p_model
      and (1 - (s.embedding operator(extensions.<=>) p_query)) >= p_gate
    order by s.embedding operator(extensions.<=>) p_query, s.id
    limit least(greatest(coalesce(p_limit, 10), 1), 20);
end;
$$;

-- The lists Satchel made, optionally one of them. Read only.
create function public.agent_shelf_lists(p_list text default null)
returns table(list text, kind text, title text, detail text, status text, amount numeric, currency text, spent_on date,
  profile text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare owner uuid;
begin
  select a.owner_id into owner from private.shelf_app() a;
  return query select w.list, w.kind, w.title, w.detail, w.status, w.amount, w.currency, w.spent_on, w.profile, w.created_at
    from public.shelf_wants w
    where w.owner_id = owner and (p_list is null or lower(w.list) = lower(btrim(p_list)))
    order by w.list, w.status, coalesce(w.spent_on::timestamptz, w.created_at) desc, w.id limit 300;
end;
$$;

-- A typed note from the app, put on the Shelf as waiting. The Shelf reads and
-- sorts it the next time the person opens it, like any drop. A retry with the
-- same id hands back the same row.
create function public.agent_add_shelf_note(p_id uuid, p_note text)
returns table(id uuid, status text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare app record;
begin
  select * into app from private.shelf_app();
  if char_length(btrim(coalesce(p_note, ''))) not between 1 and 4000 then
    raise exception 'A note needs some words, up to 4000 characters' using errcode = '22023', hint = 'satchel:invalid:shelf_note';
  end if;
  insert into public.shelf_items(id, owner_id, kind, note, added_by)
  values (p_id, app.owner_id, 'note', btrim(p_note), app.label)
  on conflict do nothing;
  if not exists (select 1 from public.shelf_items s where s.id = p_id and s.owner_id = app.owner_id
      and s.note = btrim(p_note) and s.added_by is not distinct from app.label) then
    raise exception 'This id was already used for something else' using errcode = '23505', hint = 'satchel:conflict:shelf_request';
  end if;
  return query select s.id, s.status, s.created_at from public.shelf_items s where s.id = p_id;
end;
$$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.authorize_agent_v5(text,text,boolean,boolean,uuid[],boolean,boolean)',
    'public.agent_search_shelf(extensions.vector,text,integer,real)',
    'public.agent_shelf_lists(text)',
    'public.agent_add_shelf_note(uuid,text)',
    'public.list_shelf_items(integer)',
    'public.claim_shelf_item(uuid)',
    'public.read_shelf_item(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;
revoke all on function private.shelf_app() from public, anon, authenticated;
grant execute on function private.shelf_app() to authenticated;

commit;
