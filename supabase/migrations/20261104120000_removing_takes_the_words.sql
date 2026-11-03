begin;

-- Removing a Shelf item also removes the conversation record its words were
-- sent on in, so a capture the person took back never becomes a memory.

create or replace function public.remove_shelf_item(p_id uuid)
returns table(id uuid, object_path text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  delete from public.documents d where d.owner_id = caller and d.session_key = 'shelf-' || p_id::text;
  return query with gone as (
    delete from public.shelf_items s where s.id = p_id and s.owner_id = caller
    returning s.id, s.object_path)
  select gone.id, gone.object_path from gone;
end;
$$;

commit;
