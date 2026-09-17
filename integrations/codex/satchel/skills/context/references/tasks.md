# Tasks

Satchel's database is the sole authority for a task's title, outcome, rationale, completion criteria, next action, state, priority, blocker, revision and history. A task belongs to personal scope or to a project and does not require a repository.

Personal-task access is a separate grant from personal-memory access. A task scope is `project_id=null` or a project UUID that is task-authorized, which is not the same set as the memory-authorized projects.

## Shape

| Field | Meaning |
| --- | --- |
| `title` | <=200 chars, required |
| `outcome` | what "done" looks like, <=1000 |
| `why` | rationale, <=4000 |
| `done_when` | up to 20 completion criteria, <=500 each |
| `next_action` | the exact next step, <=1000 |
| `priority` | `low` / `medium` / `high` / `urgent` |
| `status` | `inbox` / `ready` / `in_progress` / `blocked` / `done` |

## The six tools

- `list_tasks(project_id, statuses?)` - bounded summaries in one scope, optionally filtered to at most 5 states. Check `complete`.
- `read_task(project_id, id)` - one task with planning relationships, derived actionability, comments, progress updates, handoffs, verified resources and events.
- `create_task(request_id, id, project_id, ...content)` - explicit requests only.
- `edit_task(request_id, project_id, id, revision, change)` - one typed change.
- `record_task_update(request_id, project_id, id, entry)` - one typed append-only entry.
- `add_task_resource(request_id, resource_id, project_id, id, revision, label, url, resource_type, provider)` - attach an HTTPS link.

`edit_task` change kinds: `content` (full replacement of the content fields), `state` (`status` plus `blocked_reason`), `parent` (`parent_id`, nullable), `add_dependency` / `remove_dependency` (`depends_on_task_id`). One change per call.

## Comment vs progress vs handoff

These are three different things, not three labels for a note. `record_task_update` entry kinds:

- **`comment`** - lightweight discussion or context. Needs `entry_id` and `body`. No revision, because it does not change task state and must not invalidate an in-flight editor.
- **`progress`** - what moved. Needs `entry_id`, the current `revision` and a `summary`, plus optional `completed`, `decisions`, `remaining`, `blockers`, `next_action`, `status`. Advances the revision atomically and may move state.
- **`handoff`** - the stronger boundary when work stops or ownership changes. Everything progress carries, plus `validation` evidence, a required `next_action`, and `supersedes_ids` for correcting earlier handoffs.

Handoffs are append-only. A correction supersedes earlier handoff IDs; it never edits historical evidence.

Do not claim validation that was not performed. Attach a branch, commit, PR or artifact only when it actually exists and the next worker can reach it.

## Planning relationships

A task has at most one parent and any number of dependencies, all within the same owner and scope. Parent edges are decomposition; dependency edges mean the task cannot be acted on until each prerequisite is `done`. The database rejects self-links, cross-scope links and cycles in either graph.

Actionability is derived, never stored: a task is actionable when it is `ready` or `in_progress`, has a concrete `next_action`, and has no unfinished dependency. Closing or reopening a prerequisite changes downstream actionability on its own, so do not rewrite dependents to reflect it.

## Resume flow

1. Resolve an authorized task scope.
2. `list_tasks` and let the user choose one explicitly, or confirm the one you propose.
3. `read_task` for relationships, actionability, comments, progress, handoffs, resources and events.
4. Check that referenced code, documents and files are actually reachable.
5. Continue the `next_action`, or present a bounded handoff when you cannot.
6. Record new evidence and state with the revision you just read.

`in_progress` is a coordination signal, not a lock. It does not claim the task against a concurrent worker.

## Resources

`add_task_resource` stores an HTTPS link and its `label` only. Satchel never fetches it, never mirrors its status and never claims to synchronize it. `resource_type` is one of `reference`, `document`, `image`, `artifact`, `repository`, `pull_request`.

An attached GitHub issue or PR stays the external team's copy. Do not describe Satchel as tracking or updating it.
