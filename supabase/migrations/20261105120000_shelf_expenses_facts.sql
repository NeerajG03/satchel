begin;

-- Two more kinds of list line, made the same way as books and films and kept
-- by the same rules (made from drops, merged, ticked, gone with their last drop):
--   expense: a receipt or bill. Title is the shop, with the amount, currency and
--            day as printed. The tick means claimed. Lives on "Expenses".
--   fact:    something small to find in a second, like a parking spot or a
--            booking code. Title is the label, detail the value. Lives on
--            "Good to know". Two values for one label are two lines, so home
--            and office never overwrite each other.

alter table public.shelf_wants
  add column kind text not null default 'item' check (kind in ('item','expense','fact')),
  add column amount numeric(14,2) check (amount is null or amount >= 0),
  add column currency text check (currency ~ '^[A-Z]{3}$'),
  add column spent_on date;

drop function public.save_shelf_wants(uuid, jsonb);
create function public.save_shelf_wants(p_item uuid, p_wants jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
declare item public.shelf_items;
declare w jsonb;
declare line uuid;
declare k text;
declare named text;
declare sort text;
declare cost numeric(14,2);
declare day date;
declare added integer := 0;
begin
  select * into item from public.shelf_items i where i.id = p_item and i.owner_id = caller for update;
  if not found then
    raise exception 'That shelf item is gone' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
  if item.wants_at is not null then return 0; end if;
  for w in select * from jsonb_array_elements(coalesce(p_wants, '[]'::jsonb)) limit 40 loop
    sort := coalesce(w->>'kind', 'item');
    continue when sort not in ('item','expense','fact');
    cost := case when w->>'amount' ~ '^\d{1,12}(\.\d{1,2})?$' then (w->>'amount')::numeric end;
    day := case when w->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then (w->>'date')::date end;
    -- A receipt is one line per shop, amount and day: two coffees are two expenses.
    -- A fact is one line per label and value.
    k := left(case sort
      when 'expense' then concat_ws(' ', private.want_key(w->>'title'), cost::text, day::text)
      when 'fact' then private.want_key(concat_ws(' ', w->>'title', w->>'detail'))
      else private.want_key(w->>'title') end, 200);
    named := case sort when 'expense' then 'Expenses' when 'fact' then 'Good to know'
      else left(btrim(regexp_replace(coalesce(w->>'list', ''), '\s+', ' ', 'g')), 40) end;
    continue when coalesce(private.want_key(w->>'title'), '') = '' or named = '';
    -- A list already there keeps the name it has.
    select x.list into named from public.shelf_wants x where x.owner_id = caller and lower(x.list) = lower(named)
      union all select named limit 1;
    insert into public.shelf_wants(owner_id, list, title, detail, key, profile, kind, amount, currency, spent_on)
    values (caller, named, left(btrim(w->>'title'), 200), nullif(left(btrim(coalesce(w->>'detail', '')), 200), ''), k,
      item.profile, sort, cost, case when w->>'currency' ~ '^[A-Z]{3}$' then w->>'currency' end, day)
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

drop function public.list_shelf_wants();
create function public.list_shelf_wants()
returns table(id uuid, list text, title text, detail text, profile text, status text, created_at timestamptz,
  done_at timestamptz, item_ids uuid[], kind text, amount numeric, currency text, spent_on date)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select w.id, w.list, w.title, w.detail, w.profile, w.status, w.created_at, w.done_at,
      array(select s.item_id from public.shelf_want_sources s where s.want_id = w.id order by s.added_at),
      w.kind, w.amount, w.currency, w.spent_on
    from public.shelf_wants w where w.owner_id = caller
    order by w.status, coalesce(w.spent_on::timestamptz, w.created_at) desc, w.id limit 500;
end;
$$;

-- An expense or a fact stays on its own list, and a book never lands on theirs.
create or replace function private.keep_kind_on_its_list() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.list is distinct from old.list and (new.kind <> 'item' or lower(new.list) in ('expenses', 'good to know')) then
    raise exception 'An expense or a fact stays on its own list' using errcode = '22023', hint = 'satchel:invalid:want';
  end if;
  return new;
end;
$$;
create trigger shelf_wants_kind_list before update of list on public.shelf_wants
  for each row execute function private.keep_kind_on_its_list();

do $grants$
declare f text;
begin
  foreach f in array array['public.save_shelf_wants(uuid,jsonb)', 'public.list_shelf_wants()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;
revoke all on function private.keep_kind_on_its_list() from public, anon, authenticated;

commit;
