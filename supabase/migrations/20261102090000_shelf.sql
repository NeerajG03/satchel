begin;

-- The Shelf: notes, photos and voice notes the person drops in to find later.
--
-- A shelf item is not a memory. A memory is one sentence the person said; a
-- photo of a receipt is not a preference. Later a pass may read the Shelf and
-- make memories, to-dos or events from it, but this table only keeps what was
-- dropped and a description of it to search by.
--
-- Search runs on the description, embedded with the same model as memories.
-- Measured on 2 Nov: embedding the photo or voice note itself found nothing
-- the description did not, and it stayed quiet less often when nothing fit
-- (docs/shelf-plan-2026-10-31.md).
--
-- The Shelf is the person's alone for now. Every routine refuses an app token,
-- and the table has no grants, so nothing an agent holds can reach it.

create table public.shelf_items (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('note','photo','voice')),
  note text not null default '' check (char_length(note) <= 4000),
  object_path text check (char_length(object_path) <= 200),
  mime_type text check (mime_type in ('image/jpeg','image/png','image/webp','image/heic',
    'audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/ogg')),
  size_bytes integer check (size_bytes between 1 and 20971520),
  description text check (char_length(description) <= 4000),
  embedding extensions.vector(768),
  embedding_model text,
  status text not null default 'waiting' check (status in ('waiting','reading','ready','failed')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  described_at timestamptz,
  constraint shelf_note_has_no_file check ((kind = 'note') = (object_path is null)),
  constraint shelf_note_has_words check (kind <> 'note' or char_length(btrim(note)) > 0),
  constraint shelf_file_has_type check (object_path is null or (mime_type is not null and size_bytes is not null)),
  constraint shelf_type_fits_kind check (mime_type is null
    or (kind = 'photo' and mime_type like 'image/%') or (kind = 'voice' and mime_type like 'audio/%'))
);
create index shelf_items_owner_created on public.shelf_items(owner_id, created_at desc);
create unique index shelf_items_object_path on public.shelf_items(object_path) where object_path is not null;

alter table public.shelf_items enable row level security;
revoke all on table public.shelf_items from public, anon, authenticated;
-- No grants, so this policy is not what keeps anyone out. It is here so the
-- table says whose rows are whose if a grant is ever added.
create policy shelf_items_owner on public.shelf_items for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

create function private.shelf_caller() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Companion sign-in required' using errcode = '42501', hint = 'satchel:session';
  end if;
  if ((select auth.jwt())->>'client_id') is not null then
    raise exception 'The Shelf is only open in the web app' using errcode = '42501', hint = 'satchel:app_token';
  end if;
  return (select auth.uid());
end;
$$;
revoke all on function private.shelf_caller() from public, anon, authenticated;
grant execute on function private.shelf_caller() to authenticated;

-- A file's row comes first, then the upload. Storage only takes a file whose
-- path a waiting row of the same person already names, so nothing lands in the
-- bucket that the Shelf does not know about.
create function public.add_shelf_item(p_id uuid, p_kind text, p_note text,
  p_object_path text default null, p_mime_type text default null, p_size_bytes integer default null)
returns table(id uuid, kind text, note text, object_path text, mime_type text, status text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
declare existing public.shelf_items;
begin
  if p_object_path is not null and split_part(p_object_path, '/', 1) <> caller::text then
    raise exception 'A file has to sit in your own folder' using errcode = '42501', hint = 'satchel:refused:shelf_path';
  end if;
  insert into public.shelf_items(id, owner_id, kind, note, object_path, mime_type, size_bytes)
  values (p_id, caller, p_kind, coalesce(p_note, ''), p_object_path, p_mime_type, p_size_bytes)
  on conflict do nothing;
  -- Nothing inserted means the id was taken. Same thing again is a retry and
  -- gets back what was saved; anything else is a conflict.
  select * into existing from public.shelf_items s where s.id = p_id;
  if not found or existing.owner_id <> caller or existing.kind <> p_kind or existing.note <> coalesce(p_note, '')
    or existing.object_path is distinct from p_object_path then
    raise exception 'This id was already used for something else' using errcode = '23505', hint = 'satchel:conflict:shelf_request';
  end if;
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.status, s.created_at
    from public.shelf_items s where s.id = p_id;
end;
$$;

create function public.list_shelf_items(p_limit integer default 60)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at
    from public.shelf_items s where s.owner_id = caller
    order by s.created_at desc, s.id limit least(greatest(coalesce(p_limit, 60), 1), 200);
end;
$$;

-- The server takes an item to read it. One caller at a time, and only one that
-- still needs reading: a finished item is never read again, which is what
-- keeps a loop of requests from paying for the same model call over and over.
-- A read that has not reported back in two minutes is taken as lost.
create function public.claim_shelf_item(p_id uuid)
returns table(id uuid, kind text, note text, object_path text, mime_type text, size_bytes integer)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query with taken as (
    update public.shelf_items s set status = 'reading', claimed_at = now()
    where s.id = p_id and s.owner_id = caller
      and (s.status in ('waiting','failed') or (s.status = 'reading' and s.claimed_at < now() - interval '2 minutes'))
    returning s.id, s.kind, s.note, s.object_path, s.mime_type, s.size_bytes)
  select taken.id, taken.kind, taken.note, taken.object_path, taken.mime_type, taken.size_bytes from taken;
  if not found then
    if exists (select 1 from public.shelf_items s where s.id = p_id and s.owner_id = caller) then
      raise exception 'That shelf item is already read or being read' using errcode = '55000', hint = 'satchel:conflict:shelf_reading';
    end if;
    raise exception 'That shelf item is gone' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
end;
$$;

-- What the server writes once it has read the item it claimed. No description
-- and no vector means reading it failed: the item stays, unsearchable, marked
-- failed. Only a claimed item takes it, so a late failure cannot wipe a read
-- that already finished.
create function public.describe_shelf_item(p_id uuid, p_description text,
  p_embedding extensions.vector default null, p_embedding_model text default null)
returns table(id uuid, status text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  update public.shelf_items s set
    description = p_description,
    embedding = p_embedding,
    embedding_model = case when p_embedding is null then null else p_embedding_model end,
    status = case when p_embedding is null then 'failed' else 'ready' end,
    described_at = now()
  where s.id = p_id and s.owner_id = caller and s.status = 'reading';
  if not found then
    raise exception 'That shelf item is gone or not being read' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
  return query select s.id, s.status from public.shelf_items s where s.id = p_id;
end;
$$;

-- Only items embedded by the model doing the asking, because two models'
-- vectors are not comparable. The gate is measured per model: 0.63 is where
-- gemini-embedding-001 at 768 did best on the Shelf bench.
create function public.search_shelf(p_query extensions.vector, p_model text,
  p_limit integer default 20, p_gate real default 0.63)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz, similarity real)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at,
      (1 - (s.embedding operator(extensions.<=>) p_query))::real
    from public.shelf_items s
    where s.owner_id = caller and s.status = 'ready' and s.embedding_model = p_model
      and (1 - (s.embedding operator(extensions.<=>) p_query)) >= p_gate
    order by s.embedding operator(extensions.<=>) p_query, s.id
    limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

-- The person's own delete, and a real one. It hands back the file's path so
-- the web app removes the file through the Storage API, which is the only way
-- Supabase lets a stored object go.
create function public.remove_shelf_item(p_id uuid)
returns table(id uuid, object_path text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query with gone as (
    delete from public.shelf_items s where s.id = p_id and s.owner_id = caller
    returning s.id, s.object_path)
  select gone.id, gone.object_path from gone;
end;
$$;

create function private.can_upload_shelf_object(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select ((select auth.jwt())->>'client_id') is null and exists (
    select 1 from public.shelf_items s
    where s.owner_id = (select auth.uid()) and s.object_path = p_name and s.status = 'waiting');
$$;
create function private.can_read_shelf_object(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select ((select auth.jwt())->>'client_id') is null
    and split_part(p_name, '/', 1) = (select auth.uid())::text;
$$;
revoke all on function private.can_upload_shelf_object(text), private.can_read_shelf_object(text)
  from public, anon, authenticated;
grant execute on function private.can_upload_shelf_object(text), private.can_read_shelf_object(text)
  to authenticated;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.add_shelf_item(uuid,text,text,text,text,integer)',
    'public.list_shelf_items(integer)',
    'public.claim_shelf_item(uuid)',
    'public.describe_shelf_item(uuid,text,extensions.vector,text)',
    'public.search_shelf(extensions.vector,text,integer,real)',
    'public.remove_shelf_item(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

-- The bucket itself is made through the Storage API, not here, because SQL on
-- Supabase's own tables is refused (tests/supabase-owned.test.mjs): a private
-- bucket named `shelf`, 20 MB per file, the same types as mime_type above.
do $storage$ begin if to_regclass('storage.objects') is not null then
  execute $policy$ create policy shelf_upload on storage.objects for insert to authenticated
    with check (bucket_id = 'shelf' and private.can_upload_shelf_object(name)) $policy$;
  execute $policy$ create policy shelf_read on storage.objects for select to authenticated
    using (bucket_id = 'shelf' and private.can_read_shelf_object(name)) $policy$;
  execute $policy$ create policy shelf_delete on storage.objects for delete to authenticated
    using (bucket_id = 'shelf' and private.can_read_shelf_object(name)) $policy$;
end if; end $storage$;

commit;
