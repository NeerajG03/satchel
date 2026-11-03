begin;

-- A topic merged into another hands its profile to the one it went into,
-- when that one has none, and a merged-away topic is no longer counted.

create function private.profile_follows_merge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.merged_into is not null and old.merged_into is distinct from new.merged_into then
    insert into public.topic_profiles(topic_id, owner_id, kind)
    select new.merged_into, tp.owner_id, tp.kind from public.topic_profiles tp where tp.topic_id = new.id
    on conflict (topic_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.profile_follows_merge() from public, anon, authenticated;

create trigger topics_profile_follows_merge after update of merged_into on public.topics
  for each row execute function private.profile_follows_merge();

create or replace function public.list_profiles()
returns table(kind text, timezone text, topics integer)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := private.require_companion();
begin
  insert into public.profiles(owner_id, kind) values (caller, 'work'), (caller, 'personal')
  on conflict do nothing;
  return query select p.kind, p.timezone,
      (select count(*)::integer from public.topic_profiles t join public.topics tp on tp.id = t.topic_id
        where t.owner_id = caller and t.kind = p.kind and tp.merged_into is null)
    from public.profiles p where p.owner_id = caller
    order by case p.kind when 'personal' then 0 else 1 end;
end;
$$;

commit;
