begin;

-- The Shelf page groups items into their topic's section, so the list and the
-- search both say which topic an item was sorted into, and its name. A topic
-- merged since then is shown as the one it was merged into. Search also gives
-- back a voice note's words and whether it was sorted, as the list does.

drop function public.list_shelf_items(integer);
create function public.list_shelf_items(p_limit integer default 60)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz, profile text, transcript text, sorted_at timestamptz,
  topic_id uuid, topic_name text)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at,
      s.profile, s.transcript, s.sorted_at, coalesce(m.id, t.id), coalesce(m.name, t.name)
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
  topic_id uuid, topic_name text, similarity real)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at,
      s.profile, s.transcript, s.sorted_at, coalesce(m.id, t.id), coalesce(m.name, t.name),
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

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.list_shelf_items(integer)',
    'public.search_shelf(extensions.vector,text,integer,real)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

commit;
