begin;

-- Profiles: who the person is being. Two fixed kinds, work and personal,
-- because the point is routing a capture to the right calendar and to-do list,
-- and every person has exactly those two. A topic is tagged with one, and a
-- Shelf item carries one once it has been sorted. Null means not sorted yet.
--
-- Profiles are the person's own, set from the web app. Every routine here
-- refuses an app token, the same as the Shelf.

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('work','personal')),
  -- So "Tuesday 3pm" in a capture means the person's Tuesday, not the server's.
  timezone text check (timezone is null or char_length(timezone) between 1 and 64),
  created_at timestamptz not null default now(),
  unique (owner_id, kind)
);
alter table public.profiles enable row level security;
revoke all on table public.profiles from public, anon, authenticated;
create policy profiles_owner on public.profiles for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

-- Its own table rather than a column on topics, so nothing that reads a topic
-- row changes shape.
create table public.topic_profiles (
  topic_id uuid primary key references public.topics(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('work','personal'))
);
create index topic_profiles_owner on public.topic_profiles(owner_id);
alter table public.topic_profiles enable row level security;
revoke all on table public.topic_profiles from public, anon, authenticated;
create policy topic_profiles_owner on public.topic_profiles for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

alter table public.shelf_items add column profile text check (profile in ('work','personal'));

-- Both profiles, made on first look, with how many topics each holds.
create function public.list_profiles()
returns table(kind text, timezone text, topics integer)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  insert into public.profiles(owner_id, kind) values (caller, 'work'), (caller, 'personal')
  on conflict do nothing;
  return query select p.kind, p.timezone,
      (select count(*)::integer from public.topic_profiles t where t.owner_id = caller and t.kind = p.kind)
    from public.profiles p where p.owner_id = caller
    order by case p.kind when 'personal' then 0 else 1 end;
end;
$$;

create function public.set_profile_timezone(p_timezone text)
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  if p_timezone is null or char_length(p_timezone) not between 1 and 64 then
    raise exception 'That is not a timezone' using errcode = '22023', hint = 'satchel:invalid:timezone';
  end if;
  insert into public.profiles(owner_id, kind) values (caller, 'work'), (caller, 'personal')
  on conflict do nothing;
  update public.profiles set timezone = p_timezone where owner_id = caller;
end;
$$;

create function public.topic_profile_list()
returns table(topic_id uuid, kind text)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  return query select t.topic_id, t.kind from public.topic_profiles t where t.owner_id = caller;
end;
$$;

-- Null takes the topic out of both profiles.
create function public.set_topic_profile(p_topic_id uuid, p_kind text)
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  if not exists (select 1 from public.topics t where t.id = p_topic_id and t.owner_id = caller) then
    raise exception 'Topic not found' using errcode = 'P0002', hint = 'satchel:gone:topic';
  end if;
  if p_kind is null then
    delete from public.topic_profiles where topic_id = p_topic_id and owner_id = caller;
  elsif p_kind not in ('work','personal') then
    raise exception 'A profile is work or personal' using errcode = '22023', hint = 'satchel:invalid:profile';
  else
    insert into public.topic_profiles(topic_id, owner_id, kind) values (p_topic_id, caller, p_kind)
    on conflict (topic_id) do update set kind = excluded.kind where public.topic_profiles.owner_id = caller;
  end if;
end;
$$;

create function public.set_shelf_profile(p_id uuid, p_kind text)
returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  if p_kind is not null and p_kind not in ('work','personal') then
    raise exception 'A profile is work or personal' using errcode = '22023', hint = 'satchel:invalid:profile';
  end if;
  update public.shelf_items s set profile = p_kind where s.id = p_id and s.owner_id = caller;
  if not found then
    raise exception 'That shelf item is gone' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
end;
$$;

-- The Shelf's lists now say which profile each item is in.
drop function public.list_shelf_items(integer);
create function public.list_shelf_items(p_limit integer default 60)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz, profile text)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at, s.profile
    from public.shelf_items s where s.owner_id = caller
    order by s.created_at desc, s.id limit least(greatest(coalesce(p_limit, 60), 1), 200);
end;
$$;

drop function public.search_shelf(extensions.vector, text, integer, real);
create function public.search_shelf(p_query extensions.vector, p_model text,
  p_limit integer default 20, p_gate real default 0.63)
returns table(id uuid, kind text, note text, object_path text, mime_type text, description text,
  status text, created_at timestamptz, profile text, similarity real)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select s.id, s.kind, s.note, s.object_path, s.mime_type, s.description, s.status, s.created_at, s.profile,
      (1 - (s.embedding operator(extensions.<=>) p_query))::real
    from public.shelf_items s
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
    'public.list_profiles()',
    'public.set_profile_timezone(text)',
    'public.topic_profile_list()',
    'public.set_topic_profile(uuid,text)',
    'public.set_shelf_profile(uuid,text)',
    'public.list_shelf_items(integer)',
    'public.search_shelf(extensions.vector,text,integer,real)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

commit;
