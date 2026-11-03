begin;

-- An item can be sorted after it was read: one read before sorting existed,
-- or one whose sorting failed. The list says which are not sorted yet, and
-- carries what a voice note said so the person can read their own words.

drop function public.list_shelf_items(integer);
create function public.list_shelf_items(p_limit integer default 60)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz, profile text, transcript text, sorted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at,
      s.profile, s.transcript, s.sorted_at
    from public.shelf_items s where s.owner_id = caller
    order by s.created_at desc, s.id limit least(greatest(coalesce(p_limit, 60), 1), 200);
end;
$$;

-- What the server needs to sort one read item.
create function public.read_shelf_item(p_id uuid)
returns table(id uuid, kind text, note text, object_path text, mime_type text, size_bytes integer,
  description text, transcript text, status text, sorted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.size_bytes, s.description, s.transcript,
      s.status, s.sorted_at
    from public.shelf_items s where s.id = p_id and s.owner_id = caller;
  if not found then
    raise exception 'That shelf item is gone' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
end;
$$;

do $grants$
declare f text;
begin
  foreach f in array array['public.list_shelf_items(integer)', 'public.read_shelf_item(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

commit;
