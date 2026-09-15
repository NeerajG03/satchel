begin;

-- Satchel stores no skill content. A skill's home is a Git repository; these
-- tables hold sources, a browsable cache of what each source contains, the
-- user's per-target selection, and immutable releases. Agent OAuth tokens are
-- denied throughout: the shelf is companion-only.

create table public.skill_sources (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null default 'github' check (provider = 'github'),
  repository text not null check (
    repository = lower(repository)
    and repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
    and length(repository) <= 201
  ),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  is_delivery_target boolean not null default false,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, provider, repository)
);
-- One repository is both the user's source and the delivery target.
create unique index skill_sources_one_delivery_target
  on public.skill_sources(owner_id) where is_delivery_target;

-- `name` is the only identifier: the directory under skills/, the SKILL.md
-- frontmatter name, and therefore the invocation name. There is no body column.
create table public.skills (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source_id uuid not null,
  path text not null check (length(btrim(path)) between 1 and 400),
  name text not null check (
    name = lower(name) and name ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'
  ),
  description text not null default '' check (length(description) <= 280),
  seen_sha text not null check (seen_sha ~ '^[0-9a-f]{40}$'),
  synced_at timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, source_id) references public.skill_sources(owner_id, id) on delete cascade
);
-- Re-syncing upserts on this key, so a kit selection survives a source refresh.
create unique index skills_source_name on public.skills(owner_id, source_id, name);

create table public.skill_tags (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  skill_id uuid not null,
  project_id uuid not null,
  primary key (owner_id, skill_id, project_id),
  foreign key (owner_id, skill_id) references public.skills(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade
);

create table public.skill_kit_items (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  target text not null check (target in ('claude-code', 'codex')),
  skill_id uuid not null,
  added_at timestamptz not null default now(),
  primary key (owner_id, target, skill_id),
  foreign key (owner_id, skill_id) references public.skills(owner_id, id) on delete cascade
);

-- generated_paths is what lets the next publish know which paths it owns, and
-- therefore which it may delete. Without it a publish cannot tell its own
-- previous output from the user's source files.
create table public.skill_releases (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  target text not null check (target in ('claude-code', 'codex')),
  version integer not null check (version > 0),
  manifest jsonb not null,
  files jsonb not null,
  generated_paths text[] not null check (cardinality(generated_paths) between 1 and 5000),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  archive_sha256 text check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (owner_id, id),
  unique (owner_id, target, version)
);

-- This row is a claim, not a verified fact. The handler verifies installation
-- ownership against GitHub on connect and again on every publish, because a
-- definer function cannot stop a browser supplying someone else's id.
create table public.skill_delivery (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  provider text not null default 'github' check (provider = 'github'),
  repository text not null check (
    repository = lower(repository)
    and repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
    and length(repository) <= 201
  ),
  installation_id bigint not null check (installation_id > 0),
  branch text not null default 'main' check (length(btrim(branch)) between 1 and 200),
  connected_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table public.skill_sources enable row level security;
alter table public.skills enable row level security;
alter table public.skill_tags enable row level security;
alter table public.skill_kit_items enable row level security;
alter table public.skill_releases enable row level security;
alter table public.skill_delivery enable row level security;

create policy companion_skill_sources on public.skill_sources to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);
create policy companion_skills on public.skills to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);
create policy companion_skill_tags on public.skill_tags to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);
create policy companion_skill_kit_items on public.skill_kit_items to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);
create policy companion_skill_releases on public.skill_releases to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);
create policy companion_skill_delivery on public.skill_delivery to authenticated
  using (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and (select auth.jwt()->>'client_id') is null);

revoke all on public.skill_sources, public.skills, public.skill_tags,
  public.skill_kit_items, public.skill_releases, public.skill_delivery
  from public, anon, authenticated;
grant select on public.skill_sources, public.skills, public.skill_tags,
  public.skill_kit_items, public.skill_releases, public.skill_delivery to authenticated;
grant insert(id, provider, repository, is_delivery_target) on public.skill_sources to authenticated;
grant update(commit_sha, synced_at) on public.skill_sources to authenticated;
grant delete on public.skill_sources to authenticated;
grant insert(id, source_id, path, name, description, seen_sha) on public.skills to authenticated;
grant update(path, description, seen_sha, synced_at) on public.skills to authenticated;
grant delete on public.skills to authenticated;
grant insert(skill_id, project_id) on public.skill_tags to authenticated;
grant delete on public.skill_tags to authenticated;
grant insert(target, skill_id) on public.skill_kit_items to authenticated;
grant delete on public.skill_kit_items to authenticated;
grant insert(id, target, version, manifest, files, generated_paths, checksum) on public.skill_releases to authenticated;
-- A release is otherwise immutable: only the delivery outcome may be stamped.
grant update(commit_sha, archive_sha256, delivered_at) on public.skill_releases to authenticated;
grant insert(provider, repository, installation_id, branch) on public.skill_delivery to authenticated;
grant update(repository, installation_id, branch, revoked_at) on public.skill_delivery to authenticated;

-- Same retry contract as save_memory: a stable client ID makes a lost response
-- safe to resend, while an ID reused for a different payload is a conflict.
create function public.add_skill_source(p_id uuid, p_repository text, p_is_delivery_target boolean)
returns public.skill_sources language plpgsql security invoker set search_path = '' as $$
declare result public.skill_sources;
begin
  insert into public.skill_sources(id, provider, repository, is_delivery_target)
    values(p_id, 'github', lower(btrim(p_repository)), p_is_delivery_target)
    on conflict(id) do nothing;
  select * into result from public.skill_sources where id = p_id;
  if result.id is null or result.repository is distinct from lower(btrim(p_repository))
    or result.is_delivery_target is distinct from p_is_delivery_target then
    raise exception 'Skill source request conflict' using errcode = '40001';
  end if;
  return result;
end;
$$;

-- Replaces the cached rows for one source. Upserting on (source, name) keeps
-- skill IDs stable, so a refresh never silently drops a kit selection.
create function public.sync_skill_source(p_source_id uuid, p_commit_sha text, p_skills jsonb)
returns setof public.skills language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_skills) is distinct from 'array' or jsonb_array_length(p_skills) > 500 then
    raise exception 'Invalid skill list' using errcode = '23514';
  end if;
  update public.skill_sources set commit_sha = p_commit_sha, synced_at = clock_timestamp()
    where owner_id = auth.uid() and id = p_source_id;
  if not found then
    raise exception 'Skill source unavailable' using errcode = 'P0002';
  end if;

  with incoming as (
    select distinct on (nm) nm as name, pth as path, descr as description from (
      select btrim(e->>'name') as nm, btrim(e->>'path') as pth,
        left(coalesce(e->>'description', ''), 280) as descr
      from jsonb_array_elements(p_skills) e
    ) raw order by nm, pth
  )
  insert into public.skills(id, source_id, path, name, description, seen_sha)
    select gen_random_uuid(), p_source_id, i.path, i.name, i.description, p_commit_sha from incoming i
    on conflict(owner_id, source_id, name) do update
      set path = excluded.path, description = excluded.description,
        seen_sha = excluded.seen_sha, synced_at = clock_timestamp();

  delete from public.skills s where s.owner_id = auth.uid() and s.source_id = p_source_id
    and not exists (
      select 1 from jsonb_array_elements(p_skills) e where btrim(e->>'name') = s.name
    );

  return query select * from public.skills
    where owner_id = auth.uid() and source_id = p_source_id order by name;
end;
$$;

create function public.list_skills()
returns table(id uuid, source_id uuid, repository text, path text, name text,
  description text, seen_sha text, source_sha text, changed boolean)
language sql stable security invoker set search_path = '' as $$
  select s.id, s.source_id, src.repository, s.path, s.name, s.description,
    s.seen_sha, src.commit_sha, src.commit_sha is distinct from s.seen_sha
  from public.skills s join public.skill_sources src
    on src.owner_id = s.owner_id and src.id = s.source_id
  order by src.repository, s.name;
$$;

create function public.set_kit_item(p_target text, p_skill_id uuid, p_included boolean)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_included then
    insert into public.skill_kit_items(target, skill_id) values(p_target, p_skill_id)
      on conflict(owner_id, target, skill_id) do nothing;
  else
    delete from public.skill_kit_items
      where owner_id = auth.uid() and target = p_target and skill_id = p_skill_id;
  end if;
end;
$$;

-- Two-phase publish. This reserves the version and freezes the payload; a
-- concurrent publish loses the unique index and the caller retries the same ID.
create function public.open_skill_release(p_id uuid, p_target text, p_manifest jsonb,
  p_files jsonb, p_generated_paths text[], p_checksum text)
returns public.skill_releases language plpgsql security invoker set search_path = '' as $$
declare result public.skill_releases;
begin
  insert into public.skill_releases(id, target, version, manifest, files, generated_paths, checksum)
    select p_id, p_target,
      coalesce((select max(version) from public.skill_releases
        where owner_id = auth.uid() and target = p_target), 0) + 1,
      p_manifest, p_files, p_generated_paths, p_checksum
    on conflict(id) do nothing;
  select * into result from public.skill_releases where id = p_id;
  if result.id is null or result.target is distinct from p_target
    or result.checksum is distinct from p_checksum then
    raise exception 'Skill release request conflict' using errcode = '40001';
  end if;
  return result;
end;
$$;

create function public.finish_skill_release(p_id uuid, p_commit_sha text, p_archive_sha256 text)
returns public.skill_releases language plpgsql security invoker set search_path = '' as $$
declare result public.skill_releases;
begin
  update public.skill_releases set commit_sha = p_commit_sha,
    archive_sha256 = p_archive_sha256, delivered_at = clock_timestamp()
    where id = p_id and (commit_sha is null or commit_sha = p_commit_sha)
    returning * into result;
  if result.id is null then
    raise exception 'Release already delivered elsewhere or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

create function public.connect_skill_delivery(p_repository text, p_installation_id bigint)
returns public.skill_delivery language plpgsql security invoker set search_path = '' as $$
declare result public.skill_delivery;
begin
  insert into public.skill_delivery(provider, repository, installation_id)
    values('github', lower(btrim(p_repository)), p_installation_id)
    on conflict(owner_id) do update set repository = excluded.repository,
      installation_id = excluded.installation_id, revoked_at = null
    returning * into result;
  return result;
end;
$$;

revoke execute on function public.add_skill_source(uuid,text,boolean),
  public.sync_skill_source(uuid,text,jsonb), public.list_skills(),
  public.set_kit_item(text,uuid,boolean),
  public.open_skill_release(uuid,text,jsonb,jsonb,text[],text),
  public.finish_skill_release(uuid,text,text),
  public.connect_skill_delivery(text,bigint) from public, anon;
grant execute on function public.add_skill_source(uuid,text,boolean),
  public.sync_skill_source(uuid,text,jsonb), public.list_skills(),
  public.set_kit_item(text,uuid,boolean),
  public.open_skill_release(uuid,text,jsonb,jsonb,text[],text),
  public.finish_skill_release(uuid,text,text),
  public.connect_skill_delivery(text,bigint) to authenticated;

commit;
