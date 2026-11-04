begin;

-- The Shelf rearranges what is dropped on it: each book, film, place, recipe or
-- whatever the person is collecting becomes a line on a list. Lists are made
-- as drops call for them, named by Satchel ("Books", "Recipes to try"), and
-- reused when a new drop fits one already there. A list line
-- is made from the Shelf, never added by hand: it points back at the drops it
-- came from, and the one thing it keeps of its own is the person's tick.
-- The same title from two drops is one line, from two drops. When the last
-- drop behind a line is removed, the line goes too.

create function private.want_key(p_title text) returns text
language sql immutable set search_path = '' as $$
  -- "The Dune (2021)!" and "dune" are the same line: lower case, no bracketed
  -- year or note, letters and digits only, no leading article.
  select regexp_replace(
    btrim(regexp_replace(regexp_replace(lower(coalesce(p_title, '')), '\([^)]*\)|\[[^]]*\]', ' ', 'g'), '[^[:alnum:]]+', ' ', 'g')),
    '^(the|a|an) ', '');
$$;

create table public.shelf_wants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  list text not null check (char_length(btrim(list)) between 1 and 40),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  detail text check (char_length(detail) <= 200),
  key text not null check (char_length(key) between 1 and 200),
  profile text check (profile in ('work','personal')),
  status text not null default 'want' check (status in ('want','done')),
  created_at timestamptz not null default now(),
  done_at timestamptz
);
-- One line per title on a list; "books" and "Books" are the same list.
create unique index shelf_wants_line on public.shelf_wants(owner_id, lower(list), key);
create table public.shelf_want_sources (
  want_id uuid not null references public.shelf_wants(id) on delete cascade,
  item_id uuid not null references public.shelf_items(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  words text check (char_length(words) <= 1000),
  added_at timestamptz not null default now(),
  primary key (want_id, item_id)
);
create index shelf_want_sources_item on public.shelf_want_sources(item_id);
alter table public.shelf_items add column wants_at timestamptz;

alter table public.shelf_wants enable row level security;
alter table public.shelf_want_sources enable row level security;
revoke all on table public.shelf_wants, public.shelf_want_sources from public, anon, authenticated;
create policy shelf_wants_owner on public.shelf_wants for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy shelf_want_sources_owner on public.shelf_want_sources for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

-- A line with no drop left behind it goes with its last drop.
create function private.drop_orphan_wants() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.shelf_wants w where w.id = old.want_id
    and not exists (select 1 from public.shelf_want_sources s where s.want_id = old.want_id);
  return null;
end;
$$;
create trigger shelf_want_sources_orphans after delete on public.shelf_want_sources
  for each row execute function private.drop_orphan_wants();

-- What sorting found in one drop, saved once. A title already on that list
-- gains this drop as a source; a title already ticked stays ticked.
create function public.save_shelf_wants(p_item uuid, p_wants jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
declare item public.shelf_items;
declare w jsonb;
declare line uuid;
declare k text;
declare named text;
declare added integer := 0;
begin
  select * into item from public.shelf_items i where i.id = p_item and i.owner_id = caller for update;
  if not found then
    raise exception 'That shelf item is gone' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
  if item.wants_at is not null then return 0; end if;
  for w in select * from jsonb_array_elements(coalesce(p_wants, '[]'::jsonb)) limit 40 loop
    k := left(private.want_key(w->>'title'), 200);
    named := left(btrim(regexp_replace(coalesce(w->>'list', ''), '\s+', ' ', 'g')), 40);
    continue when k = '' or named = '';
    -- A list already there keeps the name it has.
    select x.list into named from public.shelf_wants x where x.owner_id = caller and lower(x.list) = lower(named)
      union all select named limit 1;
    insert into public.shelf_wants(owner_id, list, title, detail, key, profile)
    values (caller, named, left(btrim(w->>'title'), 200), nullif(left(btrim(coalesce(w->>'detail', '')), 200), ''), k, item.profile)
    on conflict (owner_id, lower(list), key) do nothing
    returning id into line;
    if line is not null then added := added + 1;
    else select x.id into line from public.shelf_wants x where x.owner_id = caller and lower(x.list) = lower(named) and x.key = k;
    end if;
    insert into public.shelf_want_sources(want_id, item_id, owner_id, words)
    values (line, p_item, caller, left(w->>'words', 1000)) on conflict do nothing;
    line := null;
  end loop;
  update public.shelf_items i set wants_at = now() where i.id = p_item;
  return added;
end;
$$;

create function public.list_shelf_wants()
returns table(id uuid, list text, title text, detail text, profile text, status text, created_at timestamptz,
  done_at timestamptz, item_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select w.id, w.list, w.title, w.detail, w.profile, w.status, w.created_at, w.done_at,
      array(select s.item_id from public.shelf_want_sources s where s.want_id = w.id order by s.added_at)
    from public.shelf_wants w where w.owner_id = caller
    order by w.status, w.created_at desc, w.id limit 500;
end;
$$;

create function public.set_shelf_want(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  if p_status not in ('want','done') then
    raise exception 'A line is wanted or done' using errcode = '22023', hint = 'satchel:invalid:want';
  end if;
  update public.shelf_wants w set status = p_status, done_at = case when p_status = 'done' then now() end
  where w.id = p_id and w.owner_id = caller;
  if not found then
    raise exception 'That line is gone' using errcode = 'P0002', hint = 'satchel:gone:want';
  end if;
end;
$$;

-- A line moved to another list joins the one already there with that title.
create function public.move_shelf_want(p_id uuid, p_list text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
declare line public.shelf_wants;
declare there uuid;
begin
  p_list := left(btrim(regexp_replace(coalesce(p_list, ''), '\s+', ' ', 'g')), 40);
  if p_list = '' then
    raise exception 'A list needs a name' using errcode = '22023', hint = 'satchel:invalid:want';
  end if;
  select * into line from public.shelf_wants w where w.id = p_id and w.owner_id = caller for update;
  if not found then
    raise exception 'That line is gone' using errcode = 'P0002', hint = 'satchel:gone:want';
  end if;
  if lower(line.list) = lower(p_list) then return line.id; end if;
  select w.id into there from public.shelf_wants w where w.owner_id = caller and lower(w.list) = lower(p_list) and w.key = line.key;
  if there is null then
    update public.shelf_wants w set list = coalesce(
      (select x.list from public.shelf_wants x where x.owner_id = caller and lower(x.list) = lower(p_list) limit 1), p_list)
    where w.id = line.id;
    return line.id;
  end if;
  insert into public.shelf_want_sources(want_id, item_id, owner_id, words, added_at)
    select there, s.item_id, s.owner_id, s.words, s.added_at from public.shelf_want_sources s where s.want_id = line.id
    on conflict do nothing;
  delete from public.shelf_wants w where w.id = line.id;
  return there;
end;
$$;

create function public.remove_shelf_want(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  delete from public.shelf_wants w where w.id = p_id and w.owner_id = caller;
end;
$$;

-- Undo on a drop: the lines it made go, unless another drop has them too. It
-- stays marked as looked at, so the old-drops pass does not bring them back.
create function public.undo_shelf_wants(p_item uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
declare gone integer;
begin
  delete from public.shelf_want_sources s where s.item_id = p_item and s.owner_id = caller;
  get diagnostics gone = row_count;
  return gone;
end;
$$;

-- The lists there are, biggest first, so sorting reuses one before making another.
create function public.shelf_list_names()
returns table(list text, lines integer)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select w.list, count(*)::integer from public.shelf_wants w where w.owner_id = caller
    group by w.list order by count(*) desc, w.list limit 40;
end;
$$;

-- The server's read of one item says whether it was looked at for lists.
drop function public.read_shelf_item(uuid);
create function public.read_shelf_item(p_id uuid)
returns table(id uuid, kind text, note text, object_path text, mime_type text, size_bytes integer,
  description text, transcript text, status text, sorted_at timestamptz,
  voice_path text, voice_mime text, voice_size integer, wants_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.size_bytes, s.description, s.transcript,
      s.status, s.sorted_at, s.voice_path, s.voice_mime, s.voice_size, s.wants_at
    from public.shelf_items s where s.id = p_id and s.owner_id = caller;
end;
$$;

-- Read drops not yet looked at for lists, for the one-time pass over old ones.
create function public.shelf_items_for_lists(p_limit integer default 5)
returns table(id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select i.id from public.shelf_items i
    where i.owner_id = caller and i.status = 'ready' and i.wants_at is null
    order by i.created_at desc limit least(greatest(coalesce(p_limit, 5), 1), 20);
end;
$$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.save_shelf_wants(uuid,jsonb)',
    'public.list_shelf_wants()',
    'public.set_shelf_want(uuid,text)',
    'public.move_shelf_want(uuid,text)',
    'public.remove_shelf_want(uuid)',
    'public.undo_shelf_wants(uuid)',
    'public.shelf_items_for_lists(integer)',
    'public.read_shelf_item(uuid)',
    'public.shelf_list_names()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;
revoke all on function private.want_key(text), private.drop_orphan_wants() from public, anon, authenticated;
grant execute on function private.want_key(text) to authenticated;

commit;
