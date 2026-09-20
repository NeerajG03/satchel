# Task schema

Every table below has RLS enabled, has its defaults revoked, and grants `select` only. There is no direct insert, update or delete for anybody. Mutations go through the functions in `operations.md`.

## `tasks`

| Group | Columns |
| --- | --- |
| Identity | `owner_id`, `project_id` (nullable), `id`, `slug`, generated `scope_key` |
| Content | `title` (1..200), `outcome` (<=1000), `why` (<=4000), `done_when text[]` (<=20 items, <=10000 chars joined), `next_action` (<=1000) |
| Planning | `status`, `priority`, `blocked_reason` (<=2000) |
| Concurrency | `revision bigint > 0` |
| Audit | `created_by`, `updated_by`, `created_at`, `updated_at`, `last_activity_at`, `closed_at` |

`status` is `inbox`, `ready`, `in_progress`, `blocked` or `done`. `priority` is `low`, `medium`, `high` or `urgent`.

Two check constraints do real work and are easy to trip over:

- blocked implies a non-empty `blocked_reason`, and any other status implies an empty one. A transition that forgets to clear the blocker fails with `23514`.
- done implies `closed_at is not null`, and not-done implies it is null. Reopening clears it.

`project_id is null` is the personal **For me** scope. It became nullable in `20260916154226_personal_tasks.sql`, which also added `scope_key`, a stored generated column equal to `project_id::text` or the literal `'personal'`.

## `scope_key` and the composite keys

Null does not compare equal to null, so a composite foreign key through `project_id` would silently stop enforcing anything for personal rows. `scope_key` gives every row a non-null scope value, so each child table can carry:

```sql
unique (owner_id, scope_key, id)
foreign key (owner_id, scope_key, task_id) references tasks(owner_id, scope_key, id)
```

Every child table carries `owner_id`, `project_id`, `scope_key` and `task_id` for this reason. A resource reference binds owner, scope and task on both sides. If you add a child table, copy this shape; do not shortcut to a single `task_id` foreign key.

## `task_updates`

One append-only work timeline, `kind` is `comment` or `progress`.

- `comment`: `body` only, plus optional resource references. Does **not** touch `tasks.revision`.
- `progress`: `summary`, `completed[]`, `decisions[]`, `remaining[]`, `blockers[]`, plus a resolved `next_action` and optional `status`/`blocked_reason` snapshot. Advances the revision and patches the task in the same transaction.

`task_update_resource_refs` links an update to already verified resources.

## `task_handoffs`

Append-only, and stronger than progress: it adds `validation jsonb[]` and `supersedes_ids uuid[]` (<=20). A correction supersedes; nothing edits a recorded handoff, and there is no public delete. `handoff_resource_refs` is the many-to-many to verified resources, and a resource may record the handoff that introduced it.

## `task_parent_edges` and `task_dependencies`

A task has at most one structural parent and any number of directed prerequisites. Both carry the same-owner, same-scope composite keys. The mutation functions serialize graph edits per owner and scope, reject self-links, and walk the graph recursively to reject cycles before touching the revision.

## `task_planning`

A `security_invoker` view over `tasks`. It adds:

| Column | Meaning |
| --- | --- |
| `parent_id` | the single parent, or null |
| `dependency_ids` | every prerequisite |
| `blocked_by_ids` | prerequisites that are not `done` |
| `child_count` | number of children |
| `actionable` | `status in ('ready','in_progress')` and a non-empty `next_action` and no unfinished prerequisite |

Reads go through this view, not `tasks`. It is the only place actionability is defined, and it is recomputed per read on purpose.

The view is defined with `select t.*`, which Postgres expands to the column list **at creation time**. A new column on `tasks` is invisible to it until the view is dropped and recreated. The slug migration had to do exactly that; see `traps.md`.

## `task_resources`

A constrained union on `kind`:

- `external_url`: a validated HTTPS URL, optional provider, no object fields, `verified` immediately. `resource_type` is one of `reference`, `document`, `image`, `artifact`, `repository`, `pull_request`.
- `storage_object`: `object_key`, `original_filename`, `media_type`, `expected_bytes`, `checksum_sha256`, `upload_status`, `failure_reason`.

`upload_status` moves `pending -> uploaded -> verified`, or `pending -> failed`. `deleted` is reserved for cleanup. See `storage.md`.

## `task_events`

Append-only audit: create, content update, state change, handoff, resource addition, upload reservation, verification, failure. Events carry compact details, never a duplicate of the task body. Every meaningful mutation writes exactly one, in the same transaction as the change.

Every event also touches `tasks.last_activity_at`, which is what lets a comment reorder a list without pretending the task content changed. Lists order by `last_activity_at desc, id`.

## `task_write_requests`

The idempotency ledger, keyed `(owner_id, request_id)`. It stores the operation, an md5 of the canonical JSONB payload, the result identities, the result revision and the completion time. Same ID and same payload returns the stored result. Same ID and a different payload is `PT409`.

## `agent_task_grants`

One row per `(owner_id, client_id, grant_id, project_id)` with `can_read`, `can_write`, `can_upload`. Personal task scope lives on `agent_connections.task_personal`, and a blanket grant lives on `task_all_projects` with no rows at all. `apps` skill has the full grant model.

## Error codes

| Code | Meaning |
| --- | --- |
| `42501` | caller or capability unauthorized |
| `P0002` | missing, or deliberately indistinguishable from unavailable |
| `PT409` | revision mismatch, idempotency mismatch, or invalid upload phase |
| `23514` | a field, state, supersession or resource invariant failed |
| `23505` | slug already taken |
