begin;

-- Integrations: where a to-do or an event goes once the person says yes.
--
-- A connection is one signed-in account (a Google account, a Notion
-- workspace). A destination is a slot, a profile's To-dos or its Calendar,
-- pointed at a plugin that uses one connection: Google Tasks, Google Calendar
-- or a Notion database. One Google sign-in can feed Personal's Calendar and
-- Tasks both, and Work's To-dos can go to Notion while its Calendar stays
-- on Google.
--
-- Tokens arrive sealed by the server, the same as google_links: the cipher is
-- bound to the owner and to seal_tag, and only the server holds the key. Both
-- tables are the person's own, from the web app only, and have no grants.

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','notion')),
  -- What makes the account itself: a Google email, a Notion workspace id.
  account text not null check (char_length(account) between 1 and 320),
  -- What the person reads: the email, the workspace's name.
  label text not null check (char_length(label) between 1 and 200),
  token_cipher text not null check (char_length(token_cipher) between 16 and 8000),
  seal_tag text not null check (char_length(seal_tag) between 1 and 400),
  scopes text not null default '' check (char_length(scopes) <= 1000),
  -- What a plugin needs to know about the account, such as the Notion user who
  -- connected it, so "assign to me" can work. Never a token.
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 4000),
  linked_at timestamptz not null default now(),
  unique (owner_id, provider, account)
);
alter table public.connections enable row level security;
revoke all on table public.connections from public, anon, authenticated;
create policy connections_owner on public.connections for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

create table public.destinations (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  profile text not null check (profile in ('work','personal')),
  slot text not null check (slot in ('todo','event')),
  plugin text not null check (plugin in ('google_tasks','google_calendar','notion_database')),
  connection_id uuid not null references public.connections(id) on delete cascade,
  -- The plugin's own choices: for Notion, which database and how its columns
  -- are filled. Checked by the server against the live database before saving.
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 8000),
  updated_at timestamptz not null default now(),
  primary key (owner_id, profile, slot),
  -- Google Tasks has no times, so it can hold to-dos but not events.
  constraint tasks_hold_todos check (plugin <> 'google_tasks' or slot = 'todo')
);
create index destinations_connection on public.destinations(connection_id);
alter table public.destinations enable row level security;
revoke all on table public.destinations from public, anon, authenticated;
create policy destinations_owner on public.destinations for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

-- Every Google link becomes a connection and two destinations, so nobody has
-- to link again. Its token stays sealed to the profile it was linked on, which
-- is why seal_tag exists. One account linked to both profiles keeps one token.
insert into public.connections(owner_id, provider, account, label, token_cipher, seal_tag, scopes, linked_at)
select distinct on (g.owner_id, g.email) g.owner_id, 'google', g.email, g.email, g.token_cipher, g.profile, g.scopes, g.linked_at
  from public.google_links g
  order by g.owner_id, g.email, case g.profile when 'personal' then 0 else 1 end;
insert into public.destinations(owner_id, profile, slot, plugin, connection_id)
select g.owner_id, g.profile, s.slot, s.plugin, c.id
  from public.google_links g
  join public.connections c on c.owner_id = g.owner_id and c.provider = 'google' and c.account = g.email
  cross join (values ('todo','google_tasks'), ('event','google_calendar')) s(slot, plugin);

create function public.list_connections()
returns table(id uuid, provider text, label text, linked_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  return query select c.id, c.provider, c.label, c.linked_at from public.connections c
    where c.owner_id = caller order by c.provider, c.linked_at;
end;
$$;

-- Signing in to the same account again replaces its token and keeps its slots.
create function public.save_connection(p_provider text, p_account text, p_label text, p_token_cipher text,
  p_seal_tag text, p_scopes text default '', p_meta jsonb default '{}')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
declare saved uuid;
begin
  if p_provider is null or p_provider not in ('google','notion') then
    raise exception 'Satchel does not connect to that' using errcode = '22023', hint = 'satchel:invalid:provider';
  end if;
  insert into public.connections(owner_id, provider, account, label, token_cipher, seal_tag, scopes, meta)
  values (caller, p_provider, p_account, p_label, p_token_cipher, p_seal_tag, coalesce(p_scopes, ''), coalesce(p_meta, '{}'))
  on conflict (owner_id, provider, account) do update
    set label = excluded.label, token_cipher = excluded.token_cipher, seal_tag = excluded.seal_tag,
      scopes = excluded.scopes, meta = excluded.meta, linked_at = now()
  returning connections.id into saved;
  return saved;
end;
$$;

-- Notion hands out a new token pair on every refresh; the old one stops working.
create function public.update_connection_token(p_id uuid, p_token_cipher text)
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  update public.connections c set token_cipher = p_token_cipher where c.id = p_id and c.owner_id = caller;
  if not found then
    raise exception 'That connection is gone' using errcode = 'P0002', hint = 'satchel:gone:connection';
  end if;
end;
$$;

-- The sealed token, for the server to open. Useless without the server's key.
create function public.connection_token(p_id uuid)
returns table(provider text, token_cipher text, seal_tag text, meta jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  return query select c.provider, c.token_cipher, c.seal_tag, c.meta from public.connections c
    where c.id = p_id and c.owner_id = caller;
  if not found then
    raise exception 'That connection is gone' using errcode = 'P0002', hint = 'satchel:gone:connection';
  end if;
end;
$$;

-- Its slots go with it. The sealed token comes back once, so the server can
-- withdraw it at the provider too.
create function public.remove_connection(p_id uuid)
returns table(provider text, token_cipher text, seal_tag text)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  return query delete from public.connections c where c.id = p_id and c.owner_id = caller
    returning c.provider, c.token_cipher, c.seal_tag;
end;
$$;

create function public.list_destinations()
returns table(profile text, slot text, plugin text, connection_id uuid, provider text, label text, settings jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  return query select d.profile, d.slot, d.plugin, d.connection_id, c.provider, c.label, d.settings
    from public.destinations d join public.connections c on c.id = d.connection_id
    where d.owner_id = caller
    order by case d.profile when 'personal' then 0 else 1 end, d.slot desc;
end;
$$;

-- A null plugin empties the slot.
create function public.set_destination(p_profile text, p_slot text, p_plugin text, p_connection_id uuid default null,
  p_settings jsonb default '{}')
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
declare provider text;
begin
  if p_profile is null or p_profile not in ('work','personal') then
    raise exception 'A profile is work or personal' using errcode = '22023', hint = 'satchel:invalid:profile';
  end if;
  if p_slot is null or p_slot not in ('todo','event') then
    raise exception 'A slot is to-dos or calendar' using errcode = '22023', hint = 'satchel:invalid:slot';
  end if;
  if p_plugin is null then
    delete from public.destinations d where d.owner_id = caller and d.profile = p_profile and d.slot = p_slot;
    return;
  end if;
  select c.provider into provider from public.connections c where c.id = p_connection_id and c.owner_id = caller;
  if provider is null then
    raise exception 'That connection is gone' using errcode = 'P0002', hint = 'satchel:gone:connection';
  end if;
  if p_plugin not in ('google_tasks','google_calendar','notion_database')
    or (p_plugin like 'google_%') <> (provider = 'google') or (p_plugin = 'google_tasks' and p_slot <> 'todo') then
    raise exception 'That plugin cannot hold this' using errcode = '22023', hint = 'satchel:invalid:plugin';
  end if;
  insert into public.destinations(owner_id, profile, slot, plugin, connection_id, settings)
  values (caller, p_profile, p_slot, p_plugin, p_connection_id, coalesce(p_settings, '{}'))
  on conflict (owner_id, profile, slot) do update
    set plugin = excluded.plugin, connection_id = excluded.connection_id, settings = excluded.settings, updated_at = now();
end;
$$;

-- What the server needs to add something to one slot, in one call.
create function public.destination_for(p_profile text, p_slot text)
returns table(plugin text, settings jsonb, connection_id uuid, provider text, token_cipher text, seal_tag text, meta jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  return query select d.plugin, d.settings, c.id, c.provider, c.token_cipher, c.seal_tag, c.meta
    from public.destinations d join public.connections c on c.id = d.connection_id
    where d.owner_id = caller and d.profile = p_profile and d.slot = p_slot;
  if not found then
    raise exception 'That slot has nowhere to go' using errcode = 'P0002', hint = 'satchel:gone:destination';
  end if;
end;
$$;

-- The phone app asks this for which profiles can take an add. It now answers
-- from the slots, so it keeps working after the move.
create or replace function public.google_link_status()
returns table(profile text, email text, linked_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  return query select distinct on (d.profile) d.profile, c.label, c.linked_at
    from public.destinations d join public.connections c on c.id = d.connection_id
    where d.owner_id = caller
    order by d.profile desc, d.slot;
end;
$$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.list_connections()',
    'public.save_connection(text,text,text,text,text,text,jsonb)',
    'public.update_connection_token(uuid,text)',
    'public.connection_token(uuid)',
    'public.remove_connection(uuid)',
    'public.list_destinations()',
    'public.set_destination(text,text,text,uuid,jsonb)',
    'public.destination_for(text,text)',
    'public.google_link_status()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

commit;
