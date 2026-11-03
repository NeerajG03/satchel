begin;

-- Sorting a Shelf item: which profile and topic it belongs to, the words
-- spoken in a voice note, and the to-dos and events it mentions. Suggestions
-- wait for the person: nothing reaches a calendar until they say Add.
--
-- Every suggestion keeps the words it came from, and the server drops any
-- whose words are not in the capture, so a suggestion is never invented.

alter table public.shelf_items
  add column topic_id uuid references public.topics(id) on delete set null,
  add column transcript text check (char_length(transcript) <= 8000),
  add column sorted_at timestamptz;

create table public.shelf_suggestions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_id uuid not null references public.shelf_items(id) on delete cascade,
  profile text check (profile in ('work','personal')),
  kind text not null check (kind in ('todo','event')),
  title text not null check (char_length(title) between 1 and 300),
  due_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  source text not null check (char_length(source) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending','added','dismissed')),
  google_link text check (char_length(google_link) <= 1000),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint event_has_a_day check (kind <> 'event' or due_date is not null or starts_at is not null),
  constraint ends_after_start check (ends_at is null or (starts_at is not null and ends_at > starts_at))
);
create index shelf_suggestions_owner_status on public.shelf_suggestions(owner_id, status, created_at desc);
create index shelf_suggestions_item on public.shelf_suggestions(item_id);
alter table public.shelf_suggestions enable row level security;
revoke all on table public.shelf_suggestions from public, anon, authenticated;
create policy shelf_suggestions_owner on public.shelf_suggestions for all to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);

-- What the sorting call is shown: the person's timezone, and their topics
-- with the profile each is in.
create function public.shelf_sort_context()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return jsonb_build_object(
    'timezone', (select p.timezone from public.profiles p where p.owner_id = caller and p.timezone is not null limit 1),
    'topics', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'brief', t.brief, 'profile', tp.kind)
        order by t.name)
      from public.topics t left join public.topic_profiles tp on tp.topic_id = t.id
      where t.owner_id = caller and t.merged_into is null), '[]'::jsonb));
end;
$$;

-- Written once per item. The person's own choice of profile is never
-- overwritten, a topic must be theirs, and a second sorting of the same item
-- adds no suggestions, so a retry cannot double the card.
create function public.save_shelf_sorting(p_id uuid, p_profile text, p_topic_id uuid,
  p_transcript text, p_suggestions jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
declare added integer := 0;
declare s jsonb;
begin
  if p_profile is not null and p_profile not in ('work','personal') then
    raise exception 'A profile is work or personal' using errcode = '22023', hint = 'satchel:invalid:profile';
  end if;
  if p_topic_id is not null and not exists (
    select 1 from public.topics t where t.id = p_topic_id and t.owner_id = caller and t.merged_into is null) then
    p_topic_id := null;
  end if;
  update public.shelf_items i set
    profile = coalesce(i.profile, p_profile),
    topic_id = coalesce(p_topic_id, i.topic_id),
    transcript = coalesce(left(p_transcript, 8000), i.transcript),
    sorted_at = now()
  where i.id = p_id and i.owner_id = caller;
  if not found then
    raise exception 'That shelf item is gone' using errcode = 'P0002', hint = 'satchel:gone:shelf_item';
  end if;
  if exists (select 1 from public.shelf_suggestions x where x.item_id = p_id) then return 0; end if;
  for s in select * from jsonb_array_elements(coalesce(p_suggestions, '[]'::jsonb)) limit 10 loop
    insert into public.shelf_suggestions(owner_id, item_id, profile, kind, title, due_date, starts_at, ends_at, source)
    values (caller, p_id,
      case when s->>'profile' in ('work','personal') then s->>'profile' else p_profile end,
      s->>'kind', left(s->>'title', 300), (s->>'due_date')::date,
      (s->>'starts_at')::timestamptz, (s->>'ends_at')::timestamptz, left(s->>'source', 1000));
    added := added + 1;
  end loop;
  return added;
end;
$$;

create function public.list_shelf_suggestions()
returns table(id uuid, item_id uuid, profile text, kind text, title text, due_date date,
  starts_at timestamptz, ends_at timestamptz, source text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select x.id, x.item_id, x.profile, x.kind, x.title, x.due_date, x.starts_at, x.ends_at, x.source, x.created_at
    from public.shelf_suggestions x where x.owner_id = caller and x.status = 'pending'
    order by coalesce(x.starts_at, x.due_date::timestamptz, x.created_at), x.id limit 50;
end;
$$;

-- Dismiss from the browser; added only by the server once Google has it. A
-- suggestion already decided is not decided again.
create function public.decide_shelf_suggestion(p_id uuid, p_status text, p_profile text default null,
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
    where x.id = p_id and x.owner_id = caller and x.status = 'pending'
    returning x.id, x.status)
  select done.id, done.status from done;
  if not found then
    raise exception 'That suggestion is gone or already decided' using errcode = 'P0002', hint = 'satchel:gone:suggestion';
  end if;
end;
$$;

-- The server reads one suggestion to act on it.
create function public.read_shelf_suggestion(p_id uuid)
returns table(id uuid, item_id uuid, profile text, kind text, title text, due_date date,
  starts_at timestamptz, ends_at timestamptz, source text, status text)
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := private.shelf_caller();
begin
  return query select x.id, x.item_id, x.profile, x.kind, x.title, x.due_date, x.starts_at, x.ends_at, x.source, x.status
    from public.shelf_suggestions x where x.id = p_id and x.owner_id = caller;
  if not found then
    raise exception 'That suggestion is gone or already decided' using errcode = 'P0002', hint = 'satchel:gone:suggestion';
  end if;
end;
$$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.shelf_sort_context()',
    'public.save_shelf_sorting(uuid,text,uuid,text,jsonb)',
    'public.list_shelf_suggestions()',
    'public.decide_shelf_suggestion(uuid,text,text,text)',
    'public.read_shelf_suggestion(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

commit;
