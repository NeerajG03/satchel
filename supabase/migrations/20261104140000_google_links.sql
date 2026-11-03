begin;

-- One Google account per profile: the person's work account on Work, their
-- own on Personal. Satchel uses it to add a to-do or event the person said
-- yes to, and to read the next week of their calendar and open tasks.
--
-- The refresh token arrives here already encrypted by the server with a key
-- only the server holds (SATCHEL_GOOGLE_TOKEN_KEY), so neither a browser nor
-- anyone reading this table can use it. It is the person's own, from the web
-- app only: every routine refuses an app token, and the table has no grants.

create table public.google_links (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  profile text not null check (profile in ('work','personal')),
  email text not null check (char_length(email) between 3 and 320),
  token_cipher text not null check (char_length(token_cipher) between 16 and 4000),
  scopes text not null default '' check (char_length(scopes) <= 1000),
  linked_at timestamptz not null default now(),
  primary key (owner_id, profile)
);
alter table public.google_links enable row level security;
revoke all on table public.google_links from public, anon, authenticated;
create policy google_links_owner on public.google_links for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

create function public.google_link_status()
returns table(profile text, email text, linked_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  return query select g.profile, g.email, g.linked_at from public.google_links g where g.owner_id = caller
    order by case g.profile when 'personal' then 0 else 1 end;
end;
$$;

create function public.save_google_link(p_profile text, p_email text, p_token_cipher text, p_scopes text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  if p_profile not in ('work','personal') then
    raise exception 'A profile is work or personal' using errcode = '22023', hint = 'satchel:invalid:profile';
  end if;
  insert into public.google_links(owner_id, profile, email, token_cipher, scopes)
  values (caller, p_profile, p_email, p_token_cipher, coalesce(p_scopes, ''))
  on conflict (owner_id, profile) do update
    set email = excluded.email, token_cipher = excluded.token_cipher, scopes = excluded.scopes, linked_at = now();
end;
$$;

-- The sealed token, for the server to open. Useless without the server's key.
create function public.google_link_token(p_profile text)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
declare sealed text;
begin
  select g.token_cipher into sealed from public.google_links g where g.owner_id = caller and g.profile = p_profile;
  if sealed is null then
    raise exception 'That profile has no Google account linked' using errcode = 'P0002', hint = 'satchel:gone:google_link';
  end if;
  return sealed;
end;
$$;

create function public.remove_google_link(p_profile text)
returns text
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
declare sealed text;
begin
  delete from public.google_links g where g.owner_id = caller and g.profile = p_profile returning g.token_cipher into sealed;
  return sealed;
end;
$$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.google_link_status()',
    'public.save_google_link(text,text,text,text)',
    'public.google_link_token(text)',
    'public.remove_google_link(text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

commit;
