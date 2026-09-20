# Projects

## Slugs

Every project has a `slug` on the same rules as a task's: lowercase words joined by hyphens, three to forty characters, unique across everything this user owns. `list_projects` returns it, and it is what the session block shows.

`upsert_project` requires one when creating. Use the short name the user already says for the project rather than a slugified version of its full name.


A project is the scope that memories and tasks hang off. It is always an explicit UUID from `list_projects`, never a folder name and never a name guessed from repository contents.

## Inspecting the connection

`list_projects()` returns this connection's effective permissions and only the projects it may access. It is the diagnostic tool: when any call is denied with `42501`, call it to see which grants actually exist, then guide the user through the host's MCP login or ask them to authorize the project in Satchel.

It deliberately still returns connection permissions when the project query itself fails, reporting `projects_error`. A broken project list is not proof that the connection is broken.

## Selecting the active project

`select_project(session_key, project_id | repository, event?)`.

- Provide exactly one of `project_id` (with `null` meaning personal scope) or `repository`. Both or neither gives `PT400`.
- `session_key` comes from the hook context. If none is available, do not invent one: use the explicitly scoped memory and task tools instead.
- `repository` resolves only through the server-side link table, and only to a project already inside this connection's grant. `PT404` means the repository is not linked or not granted: report that project context was not loaded, and do not fall back to a similar-looking project.
- Pass `event` only when the bootstrap asks for it on a new conversation or after compaction.

Selection affects this conversation only. It never changes another conversation and never grants permissions. Tell the user which scope you selected.

The return value is the combined personal plus project index. Check `complete` before claiming everything is loaded. If it comes back with `index_error`, the scope change still committed: the selection succeeded and only the index read failed, so retry the index rather than reselecting.

## Creating and revising

`upsert_project(request_id, project_id, expected_revision?, name, brief, repository_change)`, on explicit request only.

- Omit `expected_revision` to create, supplying a fresh `project_id`.
- Provide the current `expected_revision` to update an already authorized project.
- `repository_change` is `{kind:'unchanged'}`, `{kind:'link', repository}` or `{kind:'unlink', repository}`, and touches one normalized lowercase `owner/repository` without disturbing other links.

Creating a project does not expand this connection's grant. When the response sets `grant_required: true`, say plainly that the project exists but this connection cannot use it yet, and that the user has to authorize it in Satchel first. Do not retry the failing call in the meantime.
