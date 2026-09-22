begin;

-- What the consolidation pass reads, and the record of it having run.
--
-- Capture has two shapes now and they are not meant to run together:
--
--   turn     one model call at the end of every Stop, blind to what is
--            already stored, output always an insert. What ships today.
--   session  the conversation is recorded as it happens and a background
--            pass reads the whole thing later, against the memories that
--            already exist, and changes the set rather than adding to it.
--
-- A setting rather than a deploy, and it defaults to `turn`, because what
-- runs the six hourly schedule is still an open decision. Switching before
-- something calls the endpoint would mean no capture at all, and shipping
-- that gap silently is worse than shipping neither.
alter table public.memory_settings
  add column capture_mode text not null default 'turn'
    check (capture_mode in ('turn', 'session'));

/* The memories a conversation could possibly be about: the ones in its
 * project, and the personal ones, which apply everywhere.
 *
 * p_limit is a bound and not the block cap from R3. It stops one enormous
 * scope from producing a prompt nobody can pay for; the cap is a product
 * decision and it is still open. Newest first inside each scope, so the bound
 * drops the stalest rows rather than an arbitrary set, and the order is
 * deterministic because the model is given integer labels over it. */
create function public.memories_in_scope(p_project_id uuid default null, p_limit integer default 60)
returns table(id uuid, project_id uuid, project_slug text, statement text, band text,
              kind text, mentions integer, revision integer, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.project_id, p.slug, m.statement, m.band,
         m.kind, m.mentions, m.revision, m.updated_at
  from public.memories m
  left join public.projects p on p.id = m.project_id
  where (m.project_id is null or m.project_id = p_project_id)
    and m.ended_at is null
    and (m.expires_at is null or m.expires_at > now())
  order by m.project_id nulls first, m.updated_at desc, m.id
  limit greatest(coalesce(p_limit, 60), 1);
$$;

-- One row per pass, whether or not it changed anything.
--
-- memory_events already carries the trace id on every write, so this is the
-- half that has nowhere else to live: the run that decided to change nothing,
-- the run that was dropped by validation, and the run that failed. A pass
-- nobody watches is only auditable if the quiet ones are recorded too.
create table public.consolidation_runs (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  trace_id text check (length(trace_id) <= 200),
  model text not null,
  prompt text not null check (length(prompt) <= 200000),
  response text check (length(response) <= 40000),
  through bigint,
  added integer not null default 0,
  extended integer not null default 0,
  replaced integer not null default 0,
  retired integer not null default 0,
  dropped integer not null default 0,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  error text,
  created_at timestamptz not null default now()
);
create index consolidation_runs_owner_created
  on public.consolidation_runs(owner_id, created_at desc);
alter table public.consolidation_runs enable row level security;
revoke all on public.consolidation_runs from public, anon, authenticated;
grant select on public.consolidation_runs to authenticated;
grant insert(id, document_id, trace_id, model, prompt, response, through,
  added, extended, replaced, retired, dropped,
  input_tokens, output_tokens, duration_ms, error)
  on public.consolidation_runs to authenticated;
create policy owner_reads_consolidation_runs on public.consolidation_runs
  for select to authenticated using (owner_id = (select auth.uid()));
create policy actor_writes_consolidation_runs on public.consolidation_runs
  for insert to authenticated with check (owner_id = (select auth.uid()));

revoke execute on function public.memories_in_scope(uuid,integer) from public, anon;
grant execute on function public.memories_in_scope(uuid,integer) to authenticated;

commit;
