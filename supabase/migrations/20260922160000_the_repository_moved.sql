begin;

-- A memory can go stale because something merged, not because anyone said so.
--
-- R8, and the one requirement nothing we looked at attempts. mem0 and
-- supermemory both detect contradiction from conversation, which assumes the
-- world changes when the user mentions it. For a coding agent the world
-- changes when something lands.
--
-- Both stale rows in production were made false by a migration and a commit
-- last week. Nothing anyone said contradicted them, so no amount of
-- conversational contradiction detection would ever have caught it, and they
-- were the only satchel-scoped memories with embeddings: a hundred percent of
-- retrievable project memory, wrong.
--
-- The cheapest useful version, and it needs no model call to raise the doubt.
-- A memory is anchored to the repository's commit count at the moment it was
-- last meant. When the repository has moved further than a threshold since,
-- the memory is injected with a marker saying so, and the consolidation pass
-- is shown the same thing and can re-check it. Nothing is ended automatically:
-- a repository moving is a reason to doubt a claim, never a reason to know it
-- is false.

-- What the hooks have seen. One row per repository, and it only moves forward:
-- a stale hook reporting an old count must not make everything look fresh.
create table public.repository_heads (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null check (provider in ('github')),
  repository text not null check (repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  commits integer not null check (commits >= 0),
  seen_at timestamptz not null default now(),
  primary key (owner_id, provider, repository)
);
alter table public.repository_heads enable row level security;
revoke all on public.repository_heads from public, anon, authenticated;
grant select on public.repository_heads to authenticated;
create policy owner_reads_repository_heads on public.repository_heads
  for select to authenticated using (owner_id = (select auth.uid()));

create function public.record_repository_head(
  p_provider text, p_repository text, p_commits integer
) returns void language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_commits is null or p_commits < 0 then return; end if;
  insert into public.repository_heads as h (owner_id, provider, repository, commits)
    values (caller, p_provider, lower(p_repository), p_commits)
    on conflict (owner_id, provider, repository) do update
      set commits = greatest(h.commits, excluded.commits),
          seen_at = now()
      where excluded.commits >= h.commits;
end;
$$;

alter table public.memories
  add column anchor_repository text,
  add column anchor_commits integer;

alter table public.memory_settings
  add column staleness_commits integer not null default 25
    check (staleness_commits between 1 and 10000);

/* The repository a project's memories are anchored against.
 *
 * A project may link several. The most recently seen one wins, because that is
 * the one being worked in, and naming an arbitrary other would be worse than
 * naming none. Personal memories have no project and so never anchor, which is
 * right: a preference about em dashes is not falsified by a merge. */
create function private.project_head(p_project_id uuid)
returns table(repository text, commits integer)
language sql stable security definer set search_path = '' as $$
  select h.repository, h.commits
  from public.project_repositories r
  join public.repository_heads h
    on h.owner_id = r.owner_id and h.provider = r.provider and h.repository = r.repository
  where p_project_id is not null and r.project_id = p_project_id and r.owner_id = auth.uid()
  order by h.seen_at desc
  limit 1;
$$;

/* Anchored whenever the memory is meant, by the database rather than by each
 * writer, for the same reason the event trigger exists: the writer nobody
 * checks afterwards is the one that skips a step.
 *
 * "Meant" is affirmed_at moving, which now covers saving, capturing,
 * extending, affirming, confirming and correcting. Embedding does not move it
 * and neither does an expiry, so bookkeeping never resets the doubt. */
create function private.anchor_memory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare head record;
begin
  if tg_op = 'UPDATE' and new.affirmed_at is not distinct from old.affirmed_at then return new; end if;
  select * into head from private.project_head(new.project_id);
  new.anchor_repository := head.repository;
  new.anchor_commits := head.commits;
  return new;
end;
$$;
create trigger anchor_memory before insert or update on public.memories
  for each row execute function private.anchor_memory();

-- Correcting and confirming both mean "this is right, now". They did not move
-- affirmed_at, which left a corrected memory carrying the doubt of the version
-- it replaced.
create or replace function public.correct_memory(
  p_id uuid, p_revision integer, p_statement text,
  p_name text default null, p_more_info text default ''
) returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  update public.memories
    set statement = btrim(p_statement),
        name = nullif(btrim(coalesce(p_name, '')), ''),
        more_info = p_more_info,
        band = 'said',
        affirmed_at = now()
    where id = p_id and revision = p_revision
    returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

create or replace function public.confirm_memory(p_id uuid, p_revision integer)
returns public.memories language plpgsql security invoker set search_path = '' as $$
declare result public.memories;
begin
  update public.memories set band = 'said', affirmed_at = now()
    where id = p_id and revision = p_revision returning * into result;
  if result.id is null then
    raise exception 'Memory changed or unavailable' using errcode = 'PT409';
  end if;
  return result;
end;
$$;

-- The doubt travels with the row, so the caller that injects it does not have
-- to ask a second question per memory.
drop function public.search_memories(extensions.vector(768), uuid, integer, real, real, uuid[]);
create function public.search_memories(
  p_query extensions.vector(768),
  p_in_scope uuid default null,
  p_limit integer default 5,
  p_gate real default 0.67,
  p_boost real default 1.1,
  p_exclude uuid[] default '{}'
) returns table(
  id uuid, project_id uuid, statement text, band text, kind text,
  anchor_repository text, commits_since integer,
  score real, matched integer, in_scope integer
) language sql stable security invoker set search_path = '' as $$
  with settings as (
    select coalesce(p_gate, 0.67::real) as gate,
           coalesce(p_boost, 1.1::real) as boost,
           greatest(coalesce(p_limit, 5), 0) as cap,
           coalesce(p_exclude, '{}'::uuid[]) as excluded
  ), visible as (
    select m.id, m.project_id, m.statement, m.band, m.kind,
      m.anchor_repository,
      case when m.anchor_commits is null then null
           else greatest(h.commits - m.anchor_commits, 0) end as commits_since,
      (1 - (m.embedding OPERATOR(extensions.<=>) p_query))::real
        * case when p_in_scope is not null and m.project_id = p_in_scope
               then s.boost else 1 end as score
    from public.memories m
    cross join settings s
    left join public.repository_heads h
      on h.owner_id = m.owner_id and h.repository = m.anchor_repository
    where m.embedding is not null
      and m.ended_at is null
      and (m.expires_at is null or m.expires_at > now())
      and not (m.id = any(s.excluded))
  ), scored as (
    select v.*, count(*) over () as in_scope,
      count(*) filter (where v.score >= (select gate from settings)) over () as matched
    from visible v
  )
  select id, project_id, statement, band, kind, anchor_repository, commits_since, score,
    matched::integer, in_scope::integer
  from scored
  where score >= (select gate from settings)
  order by score desc, id
  limit (select cap from settings);
$$;

drop function public.memories_in_scope(uuid, integer);
create function public.memories_in_scope(p_project_id uuid default null, p_limit integer default 60)
returns table(id uuid, project_id uuid, project_slug text, statement text, band text,
              kind text, mentions integer, revision integer,
              commits_since integer, affirmed_at timestamptz, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, p.slug, m.statement, m.band,
         m.kind, m.mentions, m.revision,
         case when m.anchor_commits is null then null
              else greatest(h.commits - m.anchor_commits, 0) end,
         m.affirmed_at, m.updated_at
  from public.memories m
  left join public.projects p on p.id = m.project_id
  left join public.repository_heads h
    on h.owner_id = m.owner_id and h.repository = m.anchor_repository
  where (m.project_id is null or m.project_id = p_project_id)
    and m.ended_at is null
    and (m.expires_at is null or m.expires_at > now())
  order by m.project_id nulls first, m.updated_at desc, m.id
  limit greatest(coalesce(p_limit, 60), 1);
$$;

revoke execute on function
  private.project_head(uuid), private.anchor_memory() from public, anon, authenticated;
revoke execute on function
  public.record_repository_head(text,text,integer),
  public.search_memories(extensions.vector(768),uuid,integer,real,real,uuid[]),
  public.memories_in_scope(uuid,integer) from public, anon;
grant execute on function
  public.record_repository_head(text,text,integer),
  public.search_memories(extensions.vector(768),uuid,integer,real,real,uuid[]),
  public.memories_in_scope(uuid,integer) to authenticated;

commit;
