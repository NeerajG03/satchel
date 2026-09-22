# Querying the live database

Supabase Postgres, project `prpgcrwteepcunizdcut`. This is where you find out what survived a request, which is a different question from whether the request worked.

## Getting in

Through the Supabase **management API**, which runs SQL against the linked project. It needs a project ref and a personal access token:

```bash
SB_REF=prpgcrwteepcunizdcut
SB_TOKEN=...        # a Supabase personal access token, from the dashboard
curl -s -X POST "https://api.supabase.com/v1/projects/$SB_REF/database/query" \
  -H "Authorization: Bearer $SB_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"select count(*) from memories"}'
```

A small helper is worth keeping in the scratchpad rather than the repo, since it is three lines of urllib around that call.

Two rules, both non-negotiable:

- **The service role key never appears.** Not in a command, not in a file, not in a message. It bypasses RLS on every table for every owner. The management API token is scoped to the project and is what this is for. `SUPABASE_SERVICE_KEY` exists for local maintenance scripts only and is deliberately not on Vercel.
- **Read-only unless the write is the fix**, and say so before making it. Wrap anything exploratory in `begin; ... rollback;` so a mistake cannot land.

The application itself only ever holds the publishable key. RLS does the rest. If you are debugging an access problem, that is the point: the query you run as an admin is not the query the server runs.

## Which table answers which question

| Question | Table |
| --- | --- |
| What is stored, and is it embedded? | `memories` |
| Was anything injected into a session, and what? | `memory_injections` |
| Which writer is live for this person? | `memory_settings.capture_mode` |
| Who wrote or changed this memory, and from which trace? | `memory_events` |
| Did the consolidation pass run, and what did it decide? | `consolidation_runs` |
| What was said in a session, both halves? | `documents`, `document_turns` |
| Which sessions are waiting for the pass? | `pending_documents(30, 10)` |
| Did per-turn capture run (turn mode only)? | `router_runs` |
| What did the short window hold? | `session_messages` |
| Where is a repository, in commits? | `repository_heads` |
| Is the developer cron installed? | `consolidation_status()`, `consolidation_credentials` |
| Can this app read this scope at all? | `agent_connections` |
| Did the bootstrap stage the repository? | `agent_repository_hints` |
| Which project is this session in? | `agent_session_scopes` |
| Is this repo linked to a project? | `project_repositories` |
| Per-owner retrieval tuning | `memory_settings` |

Tasks have their own set: `tasks`, `task_events`, `task_updates`, `task_handoffs`, `task_dependencies`, `task_parent_edges`, `task_resources`.

## The queries worth having ready

**Is anything actually stored, and is it retrievable?**

```sql
select band, count(*),
       count(*) filter (where embedding is null) as unembedded,
       count(distinct embedding_model) as models
from memories group by band;
```

A row with a null embedding is saved and invisible to retrieval. More than one `embedding_model` means two incompatible vector spaces in one corpus, which ranks against noise rather than failing.

**Did retrieval inject anything, and was there anything to inject?**

```sql
select created_at, event, matched, in_scope, tokens,
       array_length(memory_ids, 1) as shown
from memory_injections order by created_at desc limit 20;
```

`matched` is how many cleared the gate, `in_scope` is how many were searched. `shown=0, matched=0, in_scope=30` means nothing scored; `in_scope=0` means nothing was searchable, which is a scope or grant problem, not a ranking one.

**Did capture run?**

```sql
select created_at, model, kept, dropped, error from router_runs order by created_at desc limit 20;
```

`kept=0` with no error is the **normal** answer on most turns and not a bug. Most conversation contains nothing that will still be true in six weeks. Read the window before concluding otherwise.

**Can this connection see anything?**

```sql
select client_id, personal, all_projects, array_length(project_ids,1) as projects,
       task_personal, task_all_projects, revoked_at
from agent_connections order by created_at desc limit 10;
```

`agent_connections` is keyed on `(owner_id, client_id)`, and every OAuth client is a different row. Claude Code's CLI registers its own client, claude.ai registers another. Authorizing one does nothing for the other, and that looks exactly like a broken grant.

**Where did this memory come from?** The first question when a memory appears that nobody expected.

```sql
select e.created_at, e.action, e.actor, e.trace_id, e.document_id, e.reason,
       left(e.after, 80) as statement
from memory_events e where e.memory_id = '<id>' order by e.created_at;
```

`actor` comes from the JWT and cannot be claimed. `trace_id` opens the Langfuse trace that decided it. Open the trace to tell the two writers apart: `satchel.consolidate` is the pass, `satchel.Stop` is the per-turn router, and the second one means that person is still on `capture_mode = 'turn'`. `router_runs` for the same minute is the cross-check.

**Did the pass run, and was it quiet or broken?**

```sql
select created_at, model, added, extended, replaced, retired, affirmed, dropped,
       duration_ms, error
from consolidation_runs order by created_at desc limit 20;
```

All zeros with no error is the **usual** answer. `error` set and `prompt = '(not sent)'` means the model was never reached and the document is still pending.

**Is a session recorded, and has the pass read it?**

```sql
select session_key, project_id, turns, chars, last_turn_at,
       consolidated_through, consolidated_at, truncated_at, expires_at
from documents order by last_turn_at desc limit 10;
```

A document with `turns` counting only one role on Claude Code means one of the two hooks is not writing. On Codex that is expected: there is no reply to record.

**Is production missing a migration?** Run this before believing any other symptom when every hook fails at once.

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 10;
```

Compare with `ls supabase/migrations`. Vercel deploys on push and migrations are applied by hand, so code can reach production before the column it reads.

## Traps this database has actually sprung

**An explicit NULL is not an absent argument.** `p_gate real default 0.67` applies when the argument is missing. JSON null arrives as SQL NULL, `score >= NULL` is NULL, and every row is dropped. The same query returned two rows with the default and zero with an explicit null, silently, everywhere.

**Direct SQL is not the path production takes.** A smoke test that calls `search_memories` in SQL skips the service layer, which is where the bugs were. Reproduce through the service.

**A new column is not read until it is named in the select.** `capture` and `capture_window` were added by a migration and `settings()` was never updated, so capture short-circuited on every request and turning the setting on in the database changed nothing.

**Column privileges are per column.** A new column on `memories` is not writable until it is named in a `grant insert(...)` and `grant update(...)`. Nothing reminds you. `capture_mode` shipped readable and unwritable, so the one switch that turned the old writer off could not be flipped from the app.

**`documents` and `document_turns` have no grants on purpose.** Querying them as an agent returns permission denied, which is correct: an agent connection is `authenticated` too, and a select grant would let it read every session. Read them through the management API, or as the person through `recent_documents` and `document_content`.

**Recreating a function can revert an earlier migration.** Read every migration that touched a function before recreating it. `agent_can_access_tasks` nearly lost its personal-task branch this way, twice.
