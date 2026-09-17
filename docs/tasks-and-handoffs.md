# Tasks and handoffs

16 September 2026. Supabase-native tasks supersede the earlier GitHub-Issues-only direction.

## One task authority

Satchel's Supabase database is the sole authority for task title, outcome, rationale, completion criteria, next action, state, priority, blocker, revision and history. Tasks belong either to **For me** or to a Satchel project and do not require a repository.

An existing GitHub issue, pull request, repository, Notion page or document can be attached as a typed HTTPS resource. Satchel does not automatically fetch it, mirror its status or claim to synchronize it. This avoids two editable copies of an external team's work while still giving a Satchel task the context needed for continuity.

## V1 operations

The companion and connected agents can list, read, create, update and transition tasks; organize hierarchy and dependencies; add append-only comments; record structured progress and handoffs; attach HTTPS links; and inspect event history. The companion also uploads private files, downloads them through authenticated Storage access and exports database records plus verified objects.

Every write has a stable request ID. Content/state writes require the current task revision. A lost response is retried with the same ID and identical payload; a stale revision is a conflict, not an overwrite.

Agents see six task tools: list, read, create, edit, record an update and attach an external resource. `edit_task` uses a typed change kind for content, state, parent or dependency edits; `record_task_update` uses a typed entry kind for comment, progress or handoff. The database operations remain separate and atomic behind this smaller MCP surface.

## Comment, progress update, or handoff

- A **comment** is lightweight discussion or context. It may reference existing verified resources, but it does not change task content or invalidate an in-flight editor.
- A **progress update** records what moved, decisions, remaining work, blockers and the next action. It atomically advances the task revision and may move its state.
- A **handoff** is the stronger boundary used when work stops or ownership/context changes. It additionally carries validation evidence and supports explicit supersession.

All three appear as durable continuation context. They are not interchangeable labels for the same free-form note.

## Planning relationships

A task may have one parent and any number of dependencies, all within the same owner and personal/project scope. Parent edges describe decomposition; dependency edges mean the task cannot be acted on until each prerequisite is done. The database rejects self-links, cross-scope links, hierarchy cycles and dependency cycles.

Actionability is derived rather than stored: a task is actionable when it is `ready` or `in_progress`, has a concrete next action and has no unfinished dependency. Closing or reopening a prerequisite therefore changes downstream actionability without rewriting every dependent task.

## A handoff is portable work evidence

A handoff records:

- work completed;
- decisions and sources;
- validation actually run and its results;
- remaining work;
- blockers;
- the exact next action;
- resources needed to resume;
- actor and time.

Handoffs are append-only. A correction supersedes earlier handoff IDs rather than editing historical evidence. Recording a handoff updates the task next action and optional state in the same database transaction, increments the revision and creates a task event.

Do not claim validation that was not performed. A branch, commit, PR or artifact should be attached only when it actually exists and the next worker can reach it.

## Resume flow

1. Resolve an authorized personal or project task scope.
2. List active tasks and choose one explicitly.
3. Read the latest task, planning relationships and actionability, comments, progress updates, handoffs, verified resources and events.
4. Check that referenced code, documents and files are reachable.
5. Continue the next action in the current environment or present a bounded handoff when launch/transfer is unavailable.
6. Record new evidence and state using the current revision.

Task `in_progress` is a coordination signal, not an exclusive lock. V1 does not claim concurrent workers atomically. If unattended claims become a requirement, design them separately.

## Resources and files

External resources are HTTPS links only and are never fetched automatically. Stored resources use the private `task-files` bucket. Their object key contains only owner, task and resource UUIDs; the filename is metadata.

File lifecycle:

```text
reserve metadata → pending → upload bytes → verify size/checksum → verified
                                └──────── failure ───────────────→ failed
```

Read, write and upload are distinct agent capabilities. Personal-task access is separate from personal-memory access. Verified files are downloaded with authenticated requests; public URLs are not used. Scope export downloads a JSON manifest and every verified object because database backups alone do not include Storage bytes.

## History and deletion

Meaningful task mutations append events in the same transaction. Events do not duplicate the entire task body. The first slice closes/reopens tasks instead of deleting them. Handoffs are not editable or deletable through public operations.

Failed/abandoned uploads need a cleanup job that removes orphaned Storage objects and advances metadata to `deleted`; that operational job is separate from interactive request transactions.

## Detailed contract

See the [Supabase-native task management LLD](task-management-lld.md) for schema, ownership constraints, RLS, atomic functions, MCP operations, upload verification, export and acceptance gates.
