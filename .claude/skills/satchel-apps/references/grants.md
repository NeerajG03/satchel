# The grant model

## `agent_connections`

Primary key `(owner_id, client_id)`. One row per app identity per person.

| Column | Meaning |
| --- | --- |
| `label` | the app's self-declared display name, trimmed, 1..100 |
| `personal` | may read personal memory |
| `all_projects` | may read memory in every project, including ones made later |
| `project_ids uuid[]` | the explicit memory project list, empty when `all_projects` is set |
| `can_write` | may save, correct, confirm and delete memory |
| `task_personal` | may reach personal tasks |
| `task_all_projects` | may reach tasks in every project, now and later |
| `task_can_write` | may create, edit and record updates |
| `task_can_upload` | may reserve and finalize task files |
| `grant_id` | the generation, rotated on every authorize and every revoke |
| `revoked_at` | set on revoke |

RLS: the companion policy allows the owner to read and write their own rows only when there is no `client_id` claim. All grants are revoked and only `select` is given back, so an agent can read its own row's projection but nothing edits the table directly. Both mutations are `SECURITY DEFINER` routines that check `auth.uid() is not null and auth.jwt()->>'client_id' is null` first.

`agent_task_grants` holds per-project task capabilities as `(owner_id, client_id, grant_id, project_id, can_read, can_write, can_upload)`. It is rewritten wholesale on every authorization, so a grant never carries rows from the previous one, and a blanket task grant writes no rows at all.

## `authorize_agent`, v1 to v3

`authorize_agent_v3` is the live one. It validates that every supplied project id belongs to the caller, caps each list at 100, rejects nulls inside the arrays, and requires at least one scope across memory and tasks (a blanket flag satisfies this on its own). Then it upserts the connection with a freshly generated `grant_id`, clears `revoked_at`, deletes the previous task grant rows and inserts the new ones.

The older signatures still exist and delegate, with `all_projects` and `task_all_projects` hard-coded false. That is not tidiness: a person re-authorizing through an older client must come back **without** a blanket grant rather than keeping one the new consent page gave them.

`revoke_agent(client_id)` sets `revoked_at` and rotates `grant_id`. Rotation is what actually kills live tokens; `revoked_at` is the record.

## The two access helpers

**`public.agent_can_access(project_id, write)`** — memory. Stable, definer, empty search path. It requires a row for this owner and client whose `grant_id` matches the JWT claim and which is not revoked, then `not write or can_write`, then: a null project needs `personal`, and a real project needs `all_projects or project_id = any(project_ids)`.

**`private.agent_can_access_tasks(project_id, capability)`** — tasks. Same generation, client and revocation checks, plus `client_id` must be present at all (a companion never goes through this helper). A null project checks `task_personal`; a real project checks `task_all_projects` or a matching `agent_task_grants` row. `read` is implied by whichever grant applied, `write` needs `task_can_write`, `upload` needs `task_can_upload`.

It lives in the unexposed `private` schema. `authenticated` has `usage` on the schema and `execute` on the narrow helpers only, so RLS policies can call it and nothing else can.

**`public.agent_connection_status()`** returns the whole effective grant as JSONB, including `task_project_ids` assembled from the grant rows. It returns null when the connection is missing, stale or revoked, which is how `http-handler.mjs` turns a dead connection into a 403 before any tool runs. The agent needs to be able to tell a blanket grant from a list, or it cannot explain its own scope to the person using it.

## Where the policies hang

Memory: `agent_project_read` on `projects`, and `agent_memory_read/insert/update/delete` on `memories`, each calling `agent_can_access` with the right write flag. Repository links get a select-only agent policy. Task tables call `private.agent_can_access_tasks` with the capability the statement needs. Storage policies allow insert only at a pre-reserved pending key for an uploader, and authenticated download only for a verified resource for a reader.

## The consent page

`src/features/connections/Consent.tsx`. Two `ScopeGroup` fieldsets, Memory and Tasks, each with **For me**, **Every project** (hinted "including ones you make later") and the individual projects. Ticking "Every project" disables and visually checks the individual boxes but stores `ids: []`: `all` is its own state, not a shortcut for ticking everything.

Quick-start buttons offer read everything, read and save everything, and clear all. Write and upload are disabled until that group has a scope, and `repository.grant()` also forces them off server-side with `hasTasks && ...`. Allow is disabled with no scope selected at all.

On allow: write the grant, then `approveAuthorization(..., { skipBrowserRedirect: true })`, stash the return URL in `sessionStorage`, and route to `/apps/connected/:partner`. On deny: `denyAuthorization` and go straight to the redirect. The grant is written **before** the approval, so an approval that fails cannot leave a token with no grant row behind it.

## The Apps page

`src/features/connections/Apps.tsx`. One card per live connection with a green light reading "reads and saves" or "reads only", and two grant lines. `GrantLine` renders a blanket grant as "Every project, including new ones" rather than a list of names, because the grant covers projects that do not exist yet and no list can show those. A project id that no longer resolves renders as "a removed project".

Revoking asks first, then calls `revoke_agent` and `auth.oauth.revokeGrant`. If the provider-side cleanup fails, the database revocation still stands and the announcement tells the person to clear the sign-in inside the app before reconnecting.

When nothing is connected, the page shows the three setup steps and the install commands from `install.ts`.
