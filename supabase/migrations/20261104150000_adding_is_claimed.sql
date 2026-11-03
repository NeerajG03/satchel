begin;

-- Adding a suggestion to Google is claimed first, so two clicks, two tabs or a
-- retry cannot make the same to-do or event twice. A claim not finished in
-- two minutes counts as lost and can be taken again.

alter table public.shelf_suggestions drop constraint shelf_suggestions_status_check;
alter table public.shelf_suggestions add constraint shelf_suggestions_status_check
  check (status in ('pending','adding','added','dismissed'));
alter table public.shelf_suggestions add column claimed_at timestamptz;

create function public.claim_shelf_suggestion(p_id uuid)
returns table(id uuid, item_id uuid, profile text, kind text, title text, due_date date,
  starts_at timestamptz, ends_at timestamptz, source text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query with taken as (
    update public.shelf_suggestions x set status = 'adding', claimed_at = now()
    where x.id = p_id and x.owner_id = caller
      and (x.status = 'pending' or (x.status = 'adding' and x.claimed_at < now() - interval '2 minutes'))
    returning x.id, x.item_id, x.profile, x.kind, x.title, x.due_date, x.starts_at, x.ends_at, x.source)
  select * from taken;
  if not found then
    raise exception 'That suggestion is gone or already decided' using errcode = 'P0002', hint = 'satchel:gone:suggestion';
  end if;
end;
$$;

-- Google did not take it: back on the card, as it was.
create function public.release_shelf_suggestion(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  update public.shelf_suggestions x set status = 'pending', claimed_at = null
  where x.id = p_id and x.owner_id = caller and x.status = 'adding';
end;
$$;

-- Added is reached only through a claim; dismissed from the card as before.
create or replace function public.decide_shelf_suggestion(p_id uuid, p_status text, p_profile text default null,
  p_google_link text default null)
returns table(id uuid, status text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  if p_status not in ('added','dismissed') then
    raise exception 'A suggestion is added or dismissed' using errcode = '22023', hint = 'satchel:invalid:suggestion';
  end if;
  return query with done as (
    update public.shelf_suggestions x set status = p_status, decided_at = now(),
      profile = coalesce(p_profile, x.profile), google_link = left(p_google_link, 1000)
    where x.id = p_id and x.owner_id = caller
      and x.status = case p_status when 'added' then 'adding' else 'pending' end
    returning x.id, x.status)
  select done.id, done.status from done;
  if not found then
    raise exception 'That suggestion is gone or already decided' using errcode = 'P0002', hint = 'satchel:gone:suggestion';
  end if;
end;
$$;

do $grants$
declare f text;
begin
  foreach f in array array['public.claim_shelf_suggestion(uuid)', 'public.release_shelf_suggestion(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

commit;
