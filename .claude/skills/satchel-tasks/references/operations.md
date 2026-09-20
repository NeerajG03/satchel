# Task operations: functions, service, tools

Three layers, and each one exists for a different reason.

```
MCP tool (6 intent-level tools, Zod-validated)
  server/task-service.mjs   scope check, then one RPC per call
    Postgres function       authorization, invariants, event, receipt, all in one transaction
      RLS                   the authority, even for a direct RPC
```

## The atomic functions

| Function | Returns | Guarantees |
| --- | --- | --- |
| `create_task` | task | stable IDs, idempotency receipt, `created` event |
| `create_task_with_slug` | task | wraps the above plus `set_slug` in one transaction |
| `update_task` | task | expected revision, content event |
| `transition_task` | task | expected revision, state invariants, state event |
| `record_task_handoff` | `{task, handoff}` | same-task supersession and resources, task patch, append-only handoff, event |
| `add_task_comment` | update | append-only, no revision check, cannot conflict |
| `record_task_progress` | `{task, update}` | task patch plus structured progress plus event |
| `set_task_parent` | `{task, parent_id}` | same scope, hierarchy cycle rejection, revision, event |
| `add_task_dependency` | `{task, depends_on_task_id}` | same scope, dependency cycle rejection, revision, event |
| `remove_task_dependency` | `{task, removed_task_id}` | expected revision, revision and event only when an edge existed |
| `add_task_resource` | `{task, resource}` | HTTPS only, never fetched, revision, event |
| `reserve_task_file` | `{task, resource}` | upload capability, immutable key, expected checksum and size |
| `finalize_task_file` | resource | checks Storage size and checksum, verified or failed event |
| `fail_task_file` | resource | records a client upload failure |
| `export_tasks` | JSON manifest | RLS-scoped tasks, handoffs, resources, references, events |
| `delete_task` | JSON summary | companion only, revision-checked, drops storage objects |

Each one keeps its transaction short and makes no network call while holding a row lock. That is why the file upload is deliberately two phases: object storage and Postgres cannot share a transaction.

`private.agent_can_access_tasks(project_id, capability)` is the stable `SECURITY DEFINER` boolean every task policy calls. It lives in the unexposed `private` schema; `authenticated` gets `usage` on the schema and `execute` on the narrow helpers only.

## `server/task-service.mjs`

Request-scoped, built per request in `http-handler.mjs` and handed the same `connectionStatus` the memory service uses. Every method calls `requireScope(projectId, capability)` first:

- no status at all is `42501`;
- `task_all_projects` is checked **before** the `task_project_ids` list, because a blanket grant keeps no list and checking the list alone would deny the connection that was given everything;
- `write` needs `task_can_write`, `upload` needs `task_can_upload`.

This check is not the authority. The database enforces the same rule. It exists so the no is early and readable instead of arriving as a policy-shaped nothing.

`list` reads `task_planning` with `count: 'exact'` and `range(0, 200)`, then reports `complete` by comparing the count to the rows and requiring fewer than 201. `read` fans out six queries in parallel and returns the task plus `scope_tasks`, `handoffs`, `updates`, `resources`, `update_resource_refs` and `events`. Every query is bounded by `AbortSignal.timeout(8000)`.

## The six MCP tools

| Tool | Shape |
| --- | --- |
| `list_tasks` | `project_id`, optional `statuses[]` |
| `read_task` | `project_id`, `id` |
| `create_task` | `request_id`, `id`, `slug`, `project_id`, content |
| `edit_task` | `request_id`, identity, `revision`, `change` |
| `record_task_update` | `request_id`, `project_id`, `id`, `entry` |
| `add_task_resource` | `request_id`, `resource_id`, identity, `revision`, `label`, HTTPS `url`, type, provider |

`change.kind` is `content`, `state`, `parent`, `add_dependency` or `remove_dependency`. `entry.kind` is `comment`, `progress` or `handoff`. Both are Zod discriminated unions, so an agent gets a typed error rather than a half-valid payload.

Six tools is a ceiling on purpose. One tool per SQL function would be fifteen near-identical names for a model to choose between; one generic mutation endpoint would be untyped. The discriminated union keeps the database's narrow routines intact while giving the model one obvious choice per intent. Add a `kind`, not a tool.

`project_id: null` means personal. It is never a directory name and never guessed.

## Slugs

A slug is how a person and a model refer to a task out loud: `resume fix-consent-layout` beats pasting a UUID. Lowercase words joined by hyphens, 3 to 40 characters, and **supplied on create, never derived from the title**. A slug derived from a long title is something nobody would say and that a model matches against worse than the title itself.

`create_task_with_slug` is a thin wrapper so the create and the slug are one round trip and one transaction: a collision (`23505`) rolls the create back rather than leaving a task named after its own title. The underlying `create_task` is untouched, so its receipt and grant checks stay in one place.

A `default_slug` trigger fills the column when nothing supplies one, so no row can ever lack a slug. `set_slug` is the single definer routine that owns slug changes; the column is never directly writable.

## Capture and retrieval touchpoints

The memory router sees tasks. `memoryService.openTasks()` feeds the end-of-turn router the 12 most recently active non-done tasks as `{slug, title, project}`, so a captured memory can be attached to a task by slug and the model never handles a UUID. `tasksByIds` lets the per-prompt injection name the task a memory belongs to. Changing the task list shape changes what the router can attach to; re-read the `satchel-memory` skill before touching it.

## Companion flow

`src/features/tasks/` mirrors the same contract: capture, detail, edit, transition, blocked sheet, timeline, update composer. `model.ts` holds the types and `replaceTask`, which re-sorts by `last_activity_at desc, id`. `repository.ts` is the only place the UI touches the database, and it is handed its Supabase client explicitly.
