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

## `memories`

```
id, owner_id, project_id, task_id
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

**The task foreign key is `(owner_id, task_id) references tasks(owner_id, id) on delete set null`.** It asks a question, it never deletes: a memory whose task closes announces a doubt before being used, and a memory whose task is deleted just loses the link. It references `(owner_id, id)` rather than the scope-qualified key because Postgres refuses `ON DELETE SET NULL` on a foreign key containing a generated column, and `tasks.scope_key` is generated. Scope agreement is therefore enforced inside `save_memory`, where it can raise something a person can read.

**Column privileges are per column.** A new column is not writable until it appears in a `grant insert(...)` / `grant update(...)`.

## `stamp_memory_revision`

Bumps `revision` and moves `updated_at` **only** when the statement, source, more_info, name, band, project or task changes.

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
returns (id, project_id, statement, band, task_id, score, matched, in_scope)
```

Every optional argument is `coalesce`d inside the function, because "not supplied" and "supplied as nothing" have to mean the same thing to every caller. A NULL gate once silenced retrieval completely.

`matched` and `in_scope` are window counts over the whole visible set, not over the returned page. They are what let an agent tell "there is no rule about this" from "nothing scored high enough".

Scope is a boost, not a filter. Rows without an embedding are invisible and do not inflate the counts.

## `personal_memories`

Every row with `project_id is null`, newest first. Loaded whole at session start rather than retrieved, because similarity measures topic overlap and a standing preference is relevant by category of activity. See `decisions.md` for the 4.4x measurement.

## `memory_settings`

One row per owner, all defaults measured.

```
per_prompt_matches     5      0..20
gate                   0.67   0..1, per embedding model
scope_boost            1.1    1..2
session_budget_tokens  15000
capture                true
capture_window         5      1..20
```

An agent connection may **read** settings and not change them. Every column the lifecycle path reads must be in `memoryService.settings()`'s select and in its no-row fallback, with matching values.

## `memory_injections`

What was injected, when, for which query, and how many tokens. This is what turns "why did it not know that" into a query, and it is the trigger for every deferred decision in the design. A failure to log never fails the injection it was recording.

## `session_messages`

The rolling window, server side. Trimmed on write to `p_keep`, expired after 24 hours. It exists so no transcript is ever read from disk on either host: `retrieve.mjs` writes the user's message when the prompt arrives and `capture.mjs` writes the reply at the end of the turn, so the router reads the conversation in the order it happened.

`classified_at` is the capture boundary. A turn is whatever has not been classified, which is a fact rather than a guess, so a Stop that failed leaves its messages for the next one and nothing is ever offered twice.

`record_session_message`, `session_window`, `clear_session_window`.

## `capture_memory`

Takes **slugs**, not ids, so the model never handles a UUID. Resolves the slug to a UUID inside the database. A task drags its own project. Always writes band `heard`.

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
