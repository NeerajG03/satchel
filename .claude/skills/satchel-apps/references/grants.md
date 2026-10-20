# The grant model

## `agent_connections`

Primary key `(owner_id, client_id)`. One row per app identity per person.

| Column | Meaning |
| --- | --- |
| `label` | the app's self-declared display name, trimmed, 1..100 |
| `personal` | may read personal memory |
| `all_topics` | may read memory in every topic, including ones made later |
| `topic_ids uuid[]` | the explicit memory topic list, empty when `all_topics` is set |
| `can_write` | may save, correct, confirm and delete memory |
| `grant_id` | the generation, rotated on every authorize and every revoke |
| `revoked_at` | set on revoke |

RLS: the companion policy allows the owner to read and write their own rows only when there is no `client_id` claim. All grants are revoked and only `select` is given back, so an agent can read its own row's projection but nothing edits the table directly. Both mutations are `SECURITY DEFINER` routines that check `auth.uid() is not null and auth.jwt()->>'client_id' is null` first.

## `authorize_agent` and `authorize_agent_v4`

`authorize_agent_v4` is the live one, and it is memory only. It validates that every supplied topic id belongs to the caller, caps the list at 100, rejects nulls inside the array, and requires at least one memory scope (a blanket flag satisfies this on its own). Then it upserts the connection with a freshly generated `grant_id` and clears `revoked_at`.

The oldest signature, `authorize_agent`, still exists and delegates, with `all_topics` hard-coded false. v2 and v3 carried task grants and were dropped with tasks in `20261020120000_satchel_has_no_tasks.sql`. That is not tidiness: a person re-authorizing through an older client must come back **without** a blanket grant rather than keeping one the new consent page gave them.

`revoke_agent(client_id)` sets `revoked_at` and rotates `grant_id`. Rotation is what actually kills live tokens; `revoked_at` is the record.

## The access helper

**`public.agent_can_access(topic_id, write)`** — memory. Stable, definer, empty search path. It requires a row for this owner and client whose `grant_id` matches the JWT claim and which is not revoked, then `not write or can_write`, then: a null topic needs `personal`, and a real topic needs `all_topics or topic_id = any(topic_ids)`.

**`public.agent_connection_status()`** returns the whole effective grant as JSONB. It returns null when the connection is missing, stale or revoked, which is how `http-handler.mjs` turns a dead connection into a 403 before any tool runs. The agent needs to be able to tell a blanket grant from a list, or it cannot explain its own scope to the person using it.

## Where the policies hang

Memory: `agent_topic_read` on `topics`, and `agent_memory_read/insert/update/delete` on `memories`, each calling `agent_can_access` with the right write flag. Repository links get a select-only agent policy.

## The consent page

`src/features/connections/Consent.tsx`. One `ScopeGroup` fieldset, Memory, with **For me** and **Every topic** (hinted "all N, and the ones made later"). Topics are all or none, so there are no single topics to tick. "Every topic" stores `ids: []`: `all` is its own state, not a shortcut for ticking everything.

Quick-start buttons offer read everything, read and save everything, and clear all. Write is disabled until there is a scope, and `repository.grant()` also forces it off when there is none. Allow is disabled with no scope selected at all.

On allow: write the grant, then `approveAuthorization(..., { skipBrowserRedirect: true })`, stash the return URL in `sessionStorage`, and route to `/apps/connected/:partner`. On deny: `denyAuthorization` and go straight to the redirect. The grant is written **before** the approval, so an approval that fails cannot leave a token with no grant row behind it.

## The Apps page

`src/features/connections/Apps.tsx`. One card per live connection with a green light reading "reads and saves" or "reads only", and a grant line for memory. `GrantLine` renders a blanket grant as "Every topic, including new ones" rather than a list of names, because the grant covers topics that do not exist yet and no list can show those. A topic id that no longer resolves renders as "a removed topic".

Revoking asks first, then calls `revoke_agent` and `auth.oauth.revokeGrant`. If the provider-side cleanup fails, the database revocation still stands and the announcement tells the person to clear the sign-in inside the app before reconnecting.

When nothing is connected, the page shows the three setup steps and the install commands from `install.ts`.
