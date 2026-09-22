# Repositories, hints and how a conversation gets a scope

## Repository links

`project_repositories` is keyed `(owner_id, provider, repository)`, with a composite foreign key to `(owner_id, project_id)`. That key is the exclusivity rule: for one owner, a repository belongs to at most one project. A project may link as many repositories as it likes.

`repository` is stored lowercase and must match `^[a-z0-9_.-]+/[a-z0-9_.-]+$`, at most 201 characters. `provider` is lowercase; only `github` is used, and the MCP surface keeps the provider implicit because only the server-side table maps a repository to a project.

Two policies: the companion policy (`client_id is null`) can do everything with its own rows; the agent policy is `select` only, and only where `agent_can_access(project_id, false)`. So an agent can read a link into a project it already has, and can never see a link into one it does not.

`link_project_repository` inserts `on conflict do nothing`, re-reads, and raises `PT409` if the repository already belongs to a different project. `unlink_project_repository` deletes. Both are `security invoker`, so RLS is the authority.

`normalizeGitHubRepository` in `src/features/projects/githubRepository.ts` turns what a person pastes (a URL, an SSH remote, `owner/name`) into the normalized form. The bootstrap script does the same job independently on the host.

## Selecting a scope for one conversation

`agent_session_scopes` is keyed `(owner_id, client_id, session_key)` and stores the `grant_id` and the chosen `project_id`. RLS is on and every grant revoked; only the two definer routines touch it.

- `select_agent_project(session_key, project_id)` requires a live connection status and, for a non-null project, `agent_can_access(project_id, false)`. It upserts the row with the current generation.
- `agent_active_project(session_key)` returns the project only when the stored generation still matches the JWT's and the connection still allows it. A rotated generation makes the selection disappear rather than linger.

A selection changes this conversation and nothing else. It grants nothing.

The `select_project` MCP tool takes **exactly one** of `project_id` (null meaning personal) or `repository`; both or neither is `PT400`. Personal scope on a connection without a personal grant is `42501`, a denial, not an empty index. After the scope is committed, it returns the combined index, and an index failure is reported as `index_error` alongside `selected: true` so a failed read never reads as a failed selection.

`select_agent_repository(session_key, provider, repository)` looks up the link under RLS and calls `select_agent_project`. A miss raises `P0002`, which the MCP layer translates to `PT404` with a message that says to report project memory as not loaded rather than guess a project.

## Resolving the repository

As of 0.3.0 this is one authenticated call.

```
SessionStart
  integrations/shared/session-start.mjs    reads git config --get remote.origin.url
    POST /api/hook-index                   authenticated, {session_key, event, repository}
      resolve_agent_repository()           invoker, RLS-bound, selects only when there is one
```

What the script sends is the session id, the event name and a normalized `owner/name`. It reads no repository content and no transcript, and it never reads or forwards the host's credentials. It bails out on anything that is not `SessionStart` or `PostCompact`, on a session id that does not match `^[A-Za-z0-9_-]{1,200}$`, and on stdin over 64 KB. `SATCHEL_DISABLE_REPOSITORY_STAGING=1` turns the repository off.

`resolve_agent_repository` returns every candidate project with `selected` on the one it activated, and it activates only when there is exactly one. Two candidates selects nothing and names them by `project_id`, because filing a memory in a real project that is the wrong project is worse than leaving it personal, which is at least visibly unscoped.

### The hint bridge it replaced

Kept for packages older than 0.3.0, and worth understanding because it explains a table that now looks unnecessary.

```
  integrations/shared/bootstrap.mjs        reads the origin, holds no credential
    POST /api/repository-hint              anonymous, {session_key, provider, repository}
      stage_agent_repository_hint()        definer, 5 minute expiry, upsert by session_key
  load_memory_context (mcp_tool, authenticated)
    agent_repository_hint_exists()         polled up to 13 times, 250ms apart
    activate_agent_repository_hint()       deletes the hint and resolves it under the grant
```

Two hops, a shared table, an expiry and a poll, all to join two facts: the command hook could see the working directory and the MCP hook held the grant. The hook scripts hold their own credential now, so the caller that knows the repository is the caller that may resolve it, and none of that is needed.

`stage_agent_repository_hint` is **the only anonymous operation in the product**. It accepts no owner, no project, no grant and no memory field, and it returns nothing. `handleRepositoryHint` rejects anything over 1024 bytes (by header and again after re-serializing the parsed object, because Vercel hands us parsed JSON), and rejects any key outside `{session_key, provider, repository}`. A hint expires after five minutes and every staging call first deletes expired rows.

`activate_agent_repository_hint` is where authorization happens. It requires a live connection, consumes the hint by deleting it, and resolves the repository only to a link whose project the connection already has. Staging a hint for somebody else's session key therefore buys nothing: the consumer is authenticated and the resolution is grant-bound.

If staging fails, the bootstrap emits different guidance telling the agent to call `select_project` once with the repository identity. That is the degraded path, and it still resolves under the grant.

The polling loop exists because the two hooks race: Claude Code can start `SessionStart` before MCP is available. Thirteen attempts at 250 ms is about three seconds, and a miss is not an error, just no active project.

## Where scope shows up elsewhere

- **Memory**: `project_id is null` is personal, and confirmed personal memories are loaded at session start, ranked and capped at `block_size`, rather than retrieved. Retrieval takes `in_scope` as a boost of 1.1, not a filter, so a first mention of an unrelated project can still win on similarity. A memory has one scope and no task link (v2.5 R9a).
- **Documents**: the session's scope is written onto its document by whichever turn first resolves it, and never cleared, because the consolidation pass reads it hours later with no workspace to resolve from. A project id the caller does not own is dropped rather than borrowed.
- **Churn**: a linked repository's commit count lives in `repository_heads`, and a project memory remembers where the repository was when it was last meant. That is how a merge, not a conversation, raises doubt about a project memory.
- **Tasks**: the same null, plus the generated `scope_key` of `'personal'` for composite foreign keys.
- **Grants**: `personal`, `all_projects` and `project_ids` for memory; `task_personal`, `task_all_projects` and `agent_task_grants` rows for tasks. Four independent switches, not one.
- **Companion UI**: `src/app/scope.ts` owns the `?scope=me|project:<id>` query and its labels.
