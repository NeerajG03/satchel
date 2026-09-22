# The schema, and the invariant each piece protects

Every function is `set search_path = ''`, so everything is schema qualified. Supabase installs pgvector into `extensions`, which is why the type, the operator and the operator class are all written as `extensions.vector(768)`, `OPERATOR(extensions.<=>)` and `extensions.vector_cosine_ops`. An unqualified `<=>` resolves at runtime against an empty path and fails.

Almost everything is `security invoker`, so RLS stays authoritative. The service layer is convenience, not security.

## The Memory v2 migrations

| version | what it does |
|---|---|
| `20260920080000` | `memory_v2_shape`: description becomes statement, adds source, band, task_id |
| `20260920090000` | `memory_v2_retrieval`: pgvector, embeddings, `search_memories`, settings, the log |
| `20260920100000` | `slugs`: slugify, backfill, the trigger, `set_slug`, the create wrappers |
| `20260920110000` | `router`: session window, `capture_memory`, `router_runs`, capture settings |
| `20260920120000` | `embedding_is_not_an_edit`: the revision trigger stops firing on bookkeeping |
| `20260920130000` | `retrieval_and_slug_fixes`: null-safe gate, slug length, hyphen, rename uniqueness |
| `20260922090000` | `documents`: the durable record of a conversation, and its retention |
| `20260922100000` | `one_scope_per_memory`: the task link is removed, everywhere |
| `20260922110000` | `memory_lifecycle`: kind, ending, expiry, repetition, and `memory_events` |
| `20260922120000` | `consolidation_runs`: `capture_mode`, `memories_in_scope`, the run log |

## `memories`

```
id, owner_id, project_id
kind             text not null   'fact' | 'preference' | 'intent', default 'fact'
ended_at         timestamptz     null while live
ended_reason     text            'replaced' | 'retired' | 'forgotten'
ended_by         uuid            the memory that replaced this one, replacements only
ended_note       text            why, <= 500
expires_at       timestamptz     null means no expiry
affirmed_at      timestamptz     the last time anyone said it again
mentions         integer         how many times, >= 1
statement        text not null   1..500 characters after trimming
source           text not null   default '', <= 4000, provenance only, never injected
band             text not null   'said' | 'heard'
name             text            nullable, an optional handle, no longer a key
more_info        text            the rare long detail
embedding        vector(768)
embedding_model  text
embedded_at      timestamptz
revision, created_at, updated_at
```

**`num_nulls(embedding, embedding_model, embedded_at) in (0, 3)`.** A row is only searchable once embedded, and an embedding is only meaningful next to the model that produced it. Changing models means re-embedding, and this pairing is what makes that detectable instead of silent.

**Name uniqueness is partial.** `where name is not null`, on both the scoped and the personal index. Without the predicate the second unnamed memory collides with the first on NULL.

**A memory has one scope: a project, or personal.** There is no task link and there is no column for one. It was removed in `20260922100000` because it produced exactly one thing, a `[task closed, may be fixed]` hint, and cost three ways to get the scope wrong: `save_memory` silently moved a memory into the task's project, so a wrong guess by a small model relocated a rule; the router made four decisions per item instead of three; and the foreign key could not be scope-qualified at all, because Postgres refuses `ON DELETE SET NULL` against a generated column and `tasks.scope_key` is generated, so a function had to enforce what the database could not. The doubt the link was for comes back in v2.5 R8, raised by the repository moving, which is what actually made the stale rows in production false. See `docs/memory-v2-5-scope.md`, R9a.

**A memory ends, it is not deleted.** `ended_at`/`ended_reason` is one way out with a reason instead of four flag pairs, and `(ended_at is null) = (ended_reason is null)` is enforced. `replaced` means the claim is false now and `ended_by` names its successor; `retired` means an intent was fulfilled, which is spent rather than wrong; `forgotten` is a decision. Expiry is separate, because it is time passing rather than something happening: a row past `expires_at` is not live and no event was raised. Everything that reads a memory to use it filters to live; `archived_memories()` is where the rest goes, and it is the undo that makes auto-applied consolidation acceptable.

**Column privileges are per column.** A new column is not writable until it appears in a `grant insert(...)` / `grant update(...)`.

## `memory_events`

Every change to a memory, with a before and an after: added, corrected, confirmed, extended, replaced, retired, forgotten. Written by an `after insert or update` trigger rather than by each writer, for the reason capture shipped for weeks without embedding its own rows: the writer nobody checks afterwards is the one that silently skips a step. A write straight at the table still leaves an event.

`actor` comes from the JWT through `private.memory_actor()`, so it cannot be claimed. `trace_id` and `document_id` are the R11 link between a row and the model run that produced it, and they are set by `private.attribute()` inside the same transaction as the write, because every PostgREST request is its own transaction and a `set_config` from outside would not be there. `satchel.change` can relabel a statement change as `extended` rather than `corrected`, which is the one piece of enrichment that cannot lie about anything that matters.

Reading an event requires being able to read its memory, expressed as a policy that checks exactly that rather than as a second copy of the grant rules. `memory_history(id)` is the ordered read.

Deleting a memory cascades its history. The system never deletes, it ends; a person's explicit delete is the one destructive act, and taking the record of a thing they asked to be gone is right rather than a gap.

## `stamp_memory_revision`

Bumps `revision` and moves `updated_at` **only** when the statement, source, more_info, name, band, project, kind or `ended_at` changes. Ending a memory moves it, so a client holding the old revision cannot go on to correct something that is no longer live. Affirming, expiring and embedding do not.

Embedding a row is bookkeeping, not an edit. The revision is the optimistic concurrency token, so bumping it for an embedding hands every client holding the old one a conflict it cannot explain, and re-embedding after a model change does that to the whole corpus at once.

## `search_memories`

```sql
search_memories(
  p_query   vector(768),
  p_in_scope uuid    default null,
  p_limit   integer  default 5,
  p_gate    real     default 0.67,
  p_boost   real     default 1.1,
  p_exclude uuid[]   default '{}')
returns (id, project_id, statement, band, kind, score, matched, in_scope)
```

Every optional argument is `coalesce`d inside the function, because "not supplied" and "supplied as nothing" have to mean the same thing to every caller. A NULL gate once silenced retrieval completely.

`matched` and `in_scope` are window counts over the whole visible set, not over the returned page. They are what let an agent tell "there is no rule about this" from "nothing scored high enough".

Scope is a boost, not a filter. Rows without an embedding are invisible and do not inflate the counts.

## `personal_memories`

Every live row with `project_id is null`, newest first. Loaded whole at session start rather than retrieved, because similarity measures topic overlap and a standing preference is relevant by category of activity. See `decisions.md` for the 4.4x measurement.

## `memory_settings`

One row per owner, all defaults measured.

```
per_prompt_matches     5      0..20
gate                   0.67   0..1, per embedding model
scope_boost            1.1    1..2
session_budget_tokens  15000
capture                true
capture_window         5      1..20
capture_mode           'turn' 'turn' | 'session'
```

`capture_mode` picks which writer runs. `turn` is one model call at the end of every Stop, blind to what is stored, output always an insert. `session` records the conversation and leaves it to the background pass, which reads the whole thing against what already exists. They are not meant to run together: two writers over the same turns save the same claim in two wordings, which production has already done once. It defaults to `turn` because what schedules the pass is still open, and switching before something calls the endpoint would mean no capture at all.

An agent connection may **read** settings and not change them. Every column the lifecycle path reads must be in `memoryService.settings()`'s select and in its no-row fallback, with matching values.

## `memory_injections`

What was injected, when, for which query, and how many tokens. This is what turns "why did it not know that" into a query, and it is the trigger for every deferred decision in the design. A failure to log never fails the injection it was recording.

## `session_messages`

The rolling window, server side. Trimmed on write to `p_keep`, expired after 24 hours. It exists so no transcript is ever read from disk on either host: `retrieve.mjs` writes the user's message when the prompt arrives and `capture.mjs` writes the reply at the end of the turn, so the router reads the conversation in the order it happened.

`classified_at` is the capture boundary. A turn is whatever has not been classified, which is a fact rather than a guess, so a Stop that failed leaves its messages for the next one and nothing is ever offered twice.

`record_session_message`, `session_window`, `clear_session_window`.

## `documents` and `document_turns`

The durable record of a conversation, kept apart from the memories derived from it. One document per `(owner_id, session_key)`; the turns hang off it in the order they were said, both roles. Memories are derived from a document and can be derived again, which is the thing capture never had: before this, a better prompt could not improve a past conversation, because the source was gone within 24 hours.

Not the same thing as `session_messages` and not a replacement for it. Different lifetimes: the window is trimmed to `p_keep` and expires in a day, a document lives 30 days. Both are written by one call, `record_turn`, because the per-prompt hook waits for it now and must not delay the prompt.

`project_id` is the scope, null meaning personal, and there is no task link. It is set by whichever turn first knows it and never cleared, because a cron reading the document hours later has no workspace and no git remote to resolve it from. A project id the caller does not own is dropped rather than borrowed.

An empty `content` is not a no-op: it creates and scopes the document without appending a turn. Codex hands over no `last_assistant_message`, so on that host the end of a turn has nothing to append but is still the moment the project is known.

Retention is a deletion, not a policy sentence: `expire_documents()` returns a row count and is called on every `record_turn`. A document stops accepting turns past 400,000 characters and sets `truncated_at`, so a reader can tell a short session from a capped one.

No table grants at all, exactly like `session_messages`. An agent connection is `authenticated` too, so a select grant would let any granted connection read every session regardless of which projects it was given.

`record_turn`, `record_document_turn`, `expire_documents`, `session_document`, `document_content`, `pending_documents`, `mark_document_consolidated`.

`consolidated_through` is the document's equivalent of `classified_at`: the last turn a consolidation pass has read. A session that carries on afterwards is pending again and only the new turns are new. It only ever moves forward.

## `memories_in_scope`

The project's live memories and the personal ones together, newest first inside each scope, with the project slug joined on. This is what the consolidation pass is shown, because a conversation inside a project still produces preferences that belong everywhere and "is this already remembered" cannot be judged against half the set. `p_limit` is a bound that stops one enormous scope producing a prompt nobody can pay for; it is not R3's block cap, which is still an open decision. The ordering is deterministic because the model is handed integer labels over it.

## `consolidation_runs`

One row per background pass, including the ones that changed nothing and the ones that failed. `memory_events` already carries the trace id on every write, so this is the half with nowhere else to live: the quiet runs. Prompt up to 200,000 characters because it holds a whole conversation, plus the raw reply, the counts by action, the tokens, the duration and the trace id.

## `capture_memory`

Takes a **slug**, not an id, so the model never handles a UUID, and one slug because a memory has one scope. Resolves it to a UUID inside the database. Always writes band `heard`.

## `router_runs`

The full prompt, the raw reply, kept and dropped counts, and the error if there was one. Prompt and response are capped at 40,000 characters. A capture you cannot explain is bad, so this is recorded even when the router fails, and losing the note never fails the turn.

## Slugs

```
slug text not null
check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40)
unique (owner_id, slug) on projects, and on tasks
```

There is no length floor. One was tried at three characters and it rejected `go`, `ui` and `qa`, which are exactly the slugs a person would pick, and it failed from inside `create_project` with a bare constraint name.

`default_slug` is one trigger serving both tables, reading `title` or `name` through jsonb so there are not two functions to drift. It picks a candidate unique across projects and tasks **together**, and on a collision appends a numeric suffix to the base trimmed to 36 characters, with the trailing hyphen trimmed off, because otherwise the truncation produces `--` and fails the pattern.

`set_slug` is the one definer routine that owns slug changes, so the column is never writable directly and ownership is checked in one place. It enforces the same cross-table uniqueness the trigger does, excluding the row being renamed so renaming to the current slug stays a no-op.

## Error codes

`PT409` for a revision conflict, not `40001`. `202609110001_conflict_responses.sql` moved conflicts onto a code that surfaces as an ordinary HTTP 409 and preserves existing grants. Recreating `save_memory` or `correct_memory` must not quietly revert that, and `tests/agent-connections.test.mjs` is what catches it when it does.

`P0002` not found, `23505` unique violation, `23514` check violation, `42501` permission denied, `PT503` retrieval unavailable.

## Testing the schema

PGlite has no pgvector, so `tests/helpers/migrations.mjs` shims the type and the distance operator. The shim is driven by what a migration **contains**, not by its filename. The real operator and the real index can only be verified against Supabase, which is what `scripts/verify-pgvector.mjs` is for.
