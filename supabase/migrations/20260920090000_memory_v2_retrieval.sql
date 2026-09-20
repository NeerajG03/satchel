begin;

-- Semantic retrieval for Memory v2. Numbers here are not guesses: the defaults
-- come from eval/, measured over a labelled 473-memory corpus. See
-- docs/memory-v2-build.md section 4.
--
-- The gate is per model, not a universal constant. 0.67 is what
-- gemini-embedding-001 at 768 dimensions calibrates to; the same corpus gives
-- 0.43 for all-minilm and 0.28 for nemotron. Changing the embedding model means
-- recalibrating with eval/run.mjs and updating memory_settings, not guessing.
--
-- Supabase installs pgvector into `extensions`, and every function in this
-- schema runs with an empty search_path, so the type, the operator and the
-- operator class are all fully qualified below. An unqualified `<=>` would
-- resolve at runtime against an empty path and fail.
create extension if not exists vector with schema extensions;

alter table public.memories
  add column embedding extensions.vector(768),
  add column embedding_model text,
  add column embedded_at timestamptz;

-- A row is only searchable once embedded, and an embedding is only meaningful
-- next to the model that produced it. Changing models means re-embedding, and
-- this pairing is what makes that detectable rather than silent.
alter table public.memories add constraint memories_embedding_pairing
  check (num_nulls(embedding, embedding_model, embedded_at) in (0, 3));

-- HNSW over cosine. The eval measured an exact scan, which is the ceiling this
-- index approximates; recall against that ceiling is verified in
-- scripts/verify-pgvector.sql against the real database, not assumed.
create index memories_embedding_hnsw on public.memories
  using hnsw (embedding extensions.vector_cosine_ops);

-- Retrieval never reads a memory the caller could not already select, because
-- it is security invoker and the existing row policies still apply.
create function public.search_memories(
  p_query extensions.vector(768),
  p_in_scope uuid default null,
  p_limit integer default 5,
  p_gate real default 0.67,
  p_boost real default 1.1,
  p_exclude uuid[] default '{}'
) returns table(
  id uuid, project_id uuid, statement text, band text, task_id uuid,
  score real, matched integer, in_scope integer
) language sql stable security invoker set search_path = '' as $$
  with visible as (
    select m.id, m.project_id, m.statement, m.band, m.task_id,
      (1 - (m.embedding OPERATOR(extensions.<=>) p_query))::real
        * case when p_in_scope is not null and m.project_id = p_in_scope
               then p_boost else 1 end as score
    from public.memories m
    where m.embedding is not null
      and not (m.id = any(p_exclude))
  ), scored as (
    select *, count(*) over () as in_scope,
      count(*) filter (where score >= p_gate) over () as matched
    from visible
  )
  select id, project_id, statement, band, task_id, score,
    matched::integer, in_scope::integer
  from scored
  where score >= p_gate
  order by score desc, id
  limit greatest(p_limit, 0);
$$;

-- Personal memories load whole at session start rather than being retrieved.
-- Section 4.10 of the build plan measures why: on prompts whose only relevant
-- memories are standing preferences, retrieval scores 0.174 and loading scores
-- 0.772. Similarity measures topic overlap; a standing rule is relevant by
-- category of activity.
create function public.personal_memories()
returns table(id uuid, statement text, band text, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.statement, m.band, m.updated_at
  from public.memories m
  where m.project_id is null
  order by m.updated_at desc, m.id;
$$;

create table public.memory_settings (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  per_prompt_matches integer not null default 5
    check (per_prompt_matches between 0 and 20),
  gate real not null default 0.67 check (gate >= 0 and gate <= 1),
  scope_boost real not null default 1.1 check (scope_boost >= 1 and scope_boost <= 2),
  session_budget_tokens integer not null default 15000
    check (session_budget_tokens between 1000 and 60000),
  updated_at timestamptz not null default now()
);
alter table public.memory_settings enable row level security;
revoke all on public.memory_settings from public, anon, authenticated;
grant select on public.memory_settings to authenticated;
grant insert(per_prompt_matches, gate, scope_boost, session_budget_tokens) on public.memory_settings to authenticated;
grant update(per_prompt_matches, gate, scope_boost, session_budget_tokens) on public.memory_settings to authenticated;

-- The companion owns settings. An agent connection may read them, because the
-- hook needs them to build a block, and may never change them.
create policy companion_memory_settings on public.memory_settings to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null)
  with check (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is null);
create policy agent_memory_settings_read on public.memory_settings for select to authenticated
  using (owner_id = (select auth.uid()) and ((select auth.jwt())->>'client_id') is not null);

-- Without this, every deferred decision in the design has no trigger and stays
-- deferred. It is also the only way to answer "why did it not know that".
create table public.memory_injections (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_key text not null check (length(session_key) between 1 and 200),
  event text not null check (event in ('SessionStart', 'UserPromptSubmit')),
  query text check (length(query) <= 2000),
  memory_ids uuid[] not null default '{}' check (cardinality(memory_ids) <= 50),
  matched integer not null default 0,
  in_scope integer not null default 0,
  tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index memory_injections_owner_created
  on public.memory_injections(owner_id, created_at desc);
alter table public.memory_injections enable row level security;
revoke all on public.memory_injections from public, anon, authenticated;
grant select on public.memory_injections to authenticated;
grant insert(id, session_key, event, query, memory_ids, matched, in_scope, tokens)
  on public.memory_injections to authenticated;

create policy owner_reads_injections on public.memory_injections for select to authenticated
  using (owner_id = (select auth.uid()));
create policy actor_writes_injections on public.memory_injections for insert to authenticated
  with check (owner_id = (select auth.uid()));

-- The new memory columns are not writable until granted, because privileges on
-- this table are column level.
grant insert(embedding, embedding_model, embedded_at) on public.memories to authenticated;
grant update(embedding, embedding_model, embedded_at) on public.memories to authenticated;

revoke execute on function
  public.search_memories(extensions.vector, uuid, integer, real, real, uuid[]),
  public.personal_memories() from public, anon;
grant execute on function
  public.search_memories(extensions.vector, uuid, integer, real, real, uuid[]),
  public.personal_memories() to authenticated;

commit;
