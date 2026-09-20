---
name: satchel-tasks
description: How Satchel's task system works and why it is built this way. Use when changing anything under the task parts of server/, supabase/migrations/, src/features/tasks/ or scripts/, when adding or altering a task tool, state, planning edge, update kind, resource or storage path, or when a decision about tasks needs the reasoning behind it. This documents the system for people building it, not for agents using it.
---

# Satchel tasks, and why they are shaped this way

A task is a work contract with a state, a next action and an append-only history. Postgres is the only authority for it. GitHub issues, pull requests and documents are links hanging off a task, never the task itself.

There is a second skill with a similar name. `integrations/shared/context/` is the skill Satchel *ships* to end users, telling their agent how to call the tools. This one is for whoever is building Satchel.

## The one paragraph version

A task belongs to exactly one scope: personal (`project_id is null`) or one project. It carries a title, outcome, why, `done_when[]`, a next action, a status, a priority and a blocker. Every content or state write supplies `expected_revision` and every write supplies a `request_id`, so a lost response is retried and a stale write is refused rather than merged. History is append-only in three shapes: a comment, a progress update and a handoff. Relationships are one parent and any number of dependencies, same scope only, cycle-checked in the database. Actionability is derived, never stored. Agents reach all of this through six intent-level MCP tools; the database keeps many narrow atomic functions behind them.

## Read this first, then route

| What you are doing | Read |
| --- | --- |
| Changing a table, a constraint, the planning view or a policy | `references/schema.md` |
| Changing a mutation function, the service or an MCP tool | `references/operations.md` |
| Changing files, uploads, export or cleanup | `references/storage.md` |
| Anything at all, before you trust a green test | `references/traps.md` |

Read `security` for the grant model and `satchel-projects` for what a scope is. Do not load a reference you are not about to use.

## The rules that outrank convenience

**Postgres owns the task; everything external is a link.** A GitHub issue attached to a task is an `external_url` resource. Satchel never fetches it, never mirrors its status and never claims to sync it. Two editable copies of another team's work is the failure being avoided.

**Every write is revision-checked and idempotent.** `expected_revision` and the increment happen in one statement. A mismatch is `PT409`, which means read again, not overwrite. `task_write_requests` keys `(owner_id, request_id)` to a payload hash: the identical retry returns the first result, the same ID with a different payload is `PT409`.

**A comment does not advance the revision.** That is the whole reason the kind exists. Discussion must not invalidate somebody else's in-flight content edit. Progress and handoffs do advance it, because they patch the canonical next action and state.

**A handoff is evidence, not a note.** Completed work, decisions, validation actually run, remaining work, blockers, the exact next action, resources. It is append-only; a correction lists `supersedes_ids` instead of editing history. Never record validation that was not performed.

**Actionability is derived.** `task_planning` computes it: ready or in progress, a non-empty next action, and no unfinished prerequisite. Closing one prerequisite changes every dependent task without rewriting any of them. Do not add an `actionable` column.

**Scope is carried in the row, not inferred.** Every child row has `owner_id`, `project_id` and a generated `scope_key` (`'personal'` or the project UUID text), and composite foreign keys bind child to parent on all three. That is what stops a policy defect from linking one person's handoff to another person's task.

**Tasks and memory are separate permissions.** Personal-task access is not personal-memory access, and write is not upload. The grant row and `private.agent_can_access_tasks` decide, and `task-service.mjs` repeats the check early only so the denial is readable.

**Deleting is a person's action.** `delete_task` calls `private.companion_only()`. An agent token has no delete path, and the consent page never offers one.

## Where things live

```
supabase/migrations/
  20260916070509_task_management.sql      tables, RLS, grants, the atomic functions
  20260916154226_personal_tasks.sql       the personal scope and its grant flag
  20260916164944_task_updates.sql         comments and progress updates
  20260916170620_task_planning_graph.sql  parents, dependencies, task_planning
  20260920100000_slugs.sql                slugs and create_task_with_slug
  20260917170000_delete_tasks_and_projects.sql  companion-only delete
server/task-service.mjs   the only place the task tools touch the database
server/mcp-server.mjs     the six task tools and their Zod contracts
src/features/tasks/       model, repository, list, capture, detail, edit, timeline
scripts/                  provision-task-storage.mjs, cleanup-task-files.mjs
tests/tasks.test.mjs      the contract and the denial paths
```

## When you change something

1. A new field, state or edge is a migration. Never edit an applied one.
2. A new MCP shape goes in the discriminated union, not a new tool. Six tools is a deliberate ceiling; see `references/operations.md`.
3. Every meaningful mutation writes exactly one `task_events` row in the same transaction. Assert it.
4. Add the denial case to `tests/tasks.test.mjs`: read-only agent, missing scope, stale generation, cross-owner. A slice is not done until its no is tested.
5. `npm test` and `npm run build` pass before a push.
