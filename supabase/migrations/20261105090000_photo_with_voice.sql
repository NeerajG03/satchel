begin;

-- A photo can carry what the person said about it: one voice note, kept as a
-- second file on the same item. Satchel writes the words down and reads the
-- photo with them, so "this is the router config from the office" is the
-- context the photo needed, and those words, being the person's own, go on to
-- the consolidation pass the way a voice note's do.

alter table public.shelf_items
  add column voice_path text check (char_length(voice_path) <= 200),
  add column voice_mime text check (voice_mime in ('audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/ogg')),
  add column voice_size integer check (voice_size between 1 and 20971520),
  add constraint shelf_voice_rides_a_photo check (voice_path is null
    or (kind = 'photo' and voice_mime is not null and voice_size is not null)),
  add constraint shelf_voice_is_its_own_file check (voice_path is null or voice_path <> object_path);
create unique index shelf_items_voice_path on public.shelf_items(voice_path) where voice_path is not null;

drop function public.add_shelf_item(uuid, text, text, text, text, integer);
create function public.add_shelf_item(p_id uuid, p_kind text, p_note text,
  p_object_path text default null, p_mime_type text default null, p_size_bytes integer default null,
  p_voice_path text default null, p_voice_mime text default null, p_voice_size integer default null)
returns table(id uuid, kind text, note text, object_path text, mime_type text, status text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
declare existing public.shelf_items;
begin
  if (p_object_path is not null and split_part(p_object_path, '/', 1) <> caller::text)
    or (p_voice_path is not null and split_part(p_voice_path, '/', 1) <> caller::text) then
    raise exception 'A file has to sit in your own folder' using errcode = '42501', hint = 'satchel:refused:shelf_path';
  end if;
  insert into public.shelf_items(id, owner_id, kind, note, object_path, mime_type, size_bytes, voice_path, voice_mime, voice_size)
  values (p_id, caller, p_kind, coalesce(p_note, ''), p_object_path, p_mime_type, p_size_bytes, p_voice_path, p_voice_mime, p_voice_size)
  on conflict do nothing;
  -- Nothing inserted means the id was taken. Same thing again is a retry and
  -- gets back what was saved; anything else is a conflict.
  select * into existing from public.shelf_items s where s.id = p_id;
  if not found or existing.owner_id <> caller or existing.kind <> p_kind or existing.note <> coalesce(p_note, '')
    or existing.object_path is distinct from p_object_path or existing.voice_path is distinct from p_voice_path then
    raise exception 'This id was already used for something else' using errcode = '23505', hint = 'satchel:conflict:shelf_request';
  end if;
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.status, s.created_at
    from public.shelf_items s where s.id = p_id;
end;
$$;

-- Storage takes the photo or its voice note only while their row is waiting.
create or replace function private.can_upload_shelf_object(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select ((select auth.jwt())->>'client_id') is null and exists (
    select 1 from public.shelf_items s
    where s.owner_id = (select auth.uid()) and (s.object_path = p_name or s.voice_path = p_name) and s.status = 'waiting');
$$;

drop function public.claim_shelf_item(uuid);
create function public.claim_shelf_item(p_id uuid)
returns table(id uuid, kind text, note text, object_path text, mime_type text, size_bytes integer,
  voice_path text, voice_mime text, voice_size integer)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query with taken as (
    update public.shelf_items s set status = 'reading', claimed_at = now()
    where s.id = p_id and s.owner_id = caller
      and (s.status in ('waiting','failed') or (s.status = 'reading' and s.claimed_at < now() - interval '2 minutes'))
    returning s.id, s.kind, s.note, s.object_path, s.mime_type, s.size_bytes, s.voice_path, s.voice_mime, s.voice_size)
  select taken.id, taken.kind, taken.note, taken.object_path, taken.mime_type, taken.size_bytes,
    taken.voice_path, taken.voice_mime, taken.voice_size from taken;
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
  voice_path text, voice_mime text, voice_size integer)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.size_bytes, s.description, s.transcript,
      s.status, s.sorted_at, s.voice_path, s.voice_mime, s.voice_size
    from public.shelf_items s where s.id = p_id and s.owner_id = caller;
end;
$$;

drop function public.list_shelf_items(integer);
create function public.list_shelf_items(p_limit integer default 60)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz, profile text, transcript text, sorted_at timestamptz,
  topic_id uuid, topic_name text, voice_path text)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at,
      s.profile, s.transcript, s.sorted_at, coalesce(m.id, t.id), coalesce(m.name, t.name), s.voice_path
    from public.shelf_items s
    left join public.topics t on t.id = s.topic_id and t.owner_id = caller
    left join public.topics m on m.id = t.merged_into and m.owner_id = caller
    where s.owner_id = caller
    order by s.created_at desc, s.id limit least(greatest(coalesce(p_limit, 60), 1), 200);
end;
$$;

drop function public.search_shelf(extensions.vector, text, integer, real);
create function public.search_shelf(p_query extensions.vector, p_model text,
  p_limit integer default 20, p_gate real default 0.63)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz, profile text, transcript text, sorted_at timestamptz,
  topic_id uuid, topic_name text, voice_path text, similarity real)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at,
      s.profile, s.transcript, s.sorted_at, coalesce(m.id, t.id), coalesce(m.name, t.name), s.voice_path,
      (1 - (s.embedding operator(extensions.<=>) p_query))::real
    from public.shelf_items s
    left join public.topics t on t.id = s.topic_id and t.owner_id = caller
    left join public.topics m on m.id = t.merged_into and m.owner_id = caller
    where s.owner_id = caller and s.status = 'ready' and s.embedding_model = p_model
      and (1 - (s.embedding operator(extensions.<=>) p_query)) >= p_gate
    order by s.embedding operator(extensions.<=>) p_query, s.id
    limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

-- Removing an item hands back both of its files, so the page deletes both.
drop function public.remove_shelf_item(uuid);
create function public.remove_shelf_item(p_id uuid)
returns table(id uuid, object_path text, voice_path text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  delete from public.documents d where d.owner_id = caller and d.session_key = 'shelf-' || p_id::text;
  return query with gone as (
    delete from public.shelf_items s where s.id = p_id and s.owner_id = caller
    returning s.id, s.object_path, s.voice_path)
  select gone.id, gone.object_path, gone.voice_path from gone;
end;
$$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.add_shelf_item(uuid,text,text,text,text,integer,text,text,integer)',
    'public.claim_shelf_item(uuid)',
    'public.read_shelf_item(uuid)',
    'public.list_shelf_items(integer)',
    'public.search_shelf(extensions.vector,text,integer,real)',
    'public.remove_shelf_item(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

commit;
