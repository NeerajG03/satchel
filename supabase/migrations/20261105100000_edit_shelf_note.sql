begin;

-- The person can change the note on something already on their Shelf. The
-- server works out the new search vector from the new words first and hands
-- it in with them, so search never finds an item by words it no longer has.
-- Only a read item (or one that could not be read) takes an edit: one still
-- arriving from a phone is matched on its note when the phone retries.

create function public.edit_shelf_note(p_id uuid, p_note text,
  p_embedding extensions.vector default null, p_embedding_model text default null)
returns table(id uuid, note text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  update public.shelf_items s set
    note = btrim(coalesce(p_note, '')),
    embedding = case when s.status = 'ready' then p_embedding else s.embedding end,
    embedding_model = case when s.status = 'ready' then p_embedding_model else s.embedding_model end
  where s.id = p_id and s.owner_id = caller and s.status in ('ready','failed')
    and (s.status <> 'ready' or (p_embedding is not null and p_embedding_model is not null));
  if not found then
    raise exception 'That shelf item is gone or still being read' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
  return query select s.id, s.note from public.shelf_items s where s.id = p_id;
end;
$$;

revoke all on function public.edit_shelf_note(uuid, text, extensions.vector, text) from public, anon, authenticated;
grant execute on function public.edit_shelf_note(uuid, text, extensions.vector, text) to authenticated;

commit;
