---
name: security
description: Use when touching migrations, RLS policies, database functions, the MCP server, the OAuth flow, the plugin hooks, tokens, environment variables or anything an agent can call. Explains how Satchel keeps every user's data private, what the trust boundaries are, and which tests must exist before a change is merged.
---

# Satchel security

Satchel holds private notes, tasks and files for many people, and it hands them to AI agents. The whole product rests on one promise: an app sees only what its owner allowed, and a person sees only their own data. Read this before touching `supabase/`, `server/`, `api/`, `integrations/` or the consent and connection pages.

## The trust model, in one picture

```
 browser (companion)            agent (Claude Code, Codex)
   Supabase Auth session          OAuth access token
   sub = user                     sub = user, client_id, satchel_grant_id
        │                                │
        ▼                                ▼
   supabase-js ──────────────►  /api/mcp  verifies JWT (issuer, audience, claims)
   publishable key only             │     builds a supabase-js client with the SAME token
        │                           ▼
        └──────────────► PostgreSQL. Row level security and security definer functions
                          decide everything. There is no service role key anywhere
                          in the browser, the MCP handler or the plugin.
```

The database is the only authority. The server and the UI are convenience layers on top of it. If a check exists only in JavaScript, it does not exist.

## Rules

**No service role key.** Not in the browser, not in `api/`, not in `server/`, not in the plugin, not in CI. The MCP handler uses the publishable key plus the caller's own bearer token, so RLS applies to agents exactly as it does to people. If you think you need the service role key, stop and open a discussion first.

**Every table has RLS and a `revoke all ... from public, anon, authenticated`.** Access goes through owner policies or through `security definer` functions. Every `security definer` function sets `search_path = ''` and uses schema-qualified names. Revoke execute from `public` and `anon`, grant to `authenticated` only. Look at `supabase/migrations/202609110003_agent_connections.sql` for the pattern.

**Two callers, two sets of policies.** A companion session is identified by `auth.uid()`. An agent token also carries `client_id` and `satchel_grant_id`. Agent policies check the grant row: it belongs to the owner, it is not revoked, its `grant_id` matches the token, and the requested project is in the grant. Never reuse a companion session as agent authorization, and never let an agent policy fall back to plain owner checks.

**Scopes are explicit.** Personal scope is `project_id = null`. Project scope is a real UUID from the grant, or the connection's `all_projects` flag. An unknown scope must not default to personal. Personal access needs its own grant flag, and `all_projects` does not imply it: a blanket grant is every project, not everything. A missing grant is a denial, never an empty list.

**"Every project" is a flag, never a list.** The consent page used to build "select all" as `projects.map(p => p.id)`, which froze a set of UUIDs, so a project made the next day was invisible to an app that had been given everything. `all_projects` and `task_all_projects` are the grant saying something that stays true about projects that do not exist yet. Three rules keep that safe:

- It defaults to false and is never backfilled. An existing grant keeps its frozen list until the person authorizes again and sees what they are agreeing to. Widening a live grant in a migration is the same bug pointing the other way.
- A blanket grant stores an empty `project_ids`, so a stale list can never sit beside the flag looking authoritative in the UI or in `agent_connection_status`.
- Older signatures delegate to `authorize_agent_v3` with the flag false, so re-authorizing through an older client clears a blanket grant rather than keeping one.

Everything else still applies: it is per connection, revocation still rotates `grant_id`, and it still cannot reach another owner.

**Revocation is immediate.** Revoking rotates `grant_id`, so an unexpired token stops working on the next call. Re-consent must not revive an old token. Keep it that way.

**Writes are safe to retry and safe against races.** Creates take a caller-supplied `id` and `request_id`. The same pair with the same payload returns the existing record. A different payload is a conflict. Updates take the expected `revision` and fail with a conflict on mismatch instead of overwriting. Deletes check the revision too.

**Agents cannot delete tasks or projects.** Only a person can. Agents can forget a memory only within a scope they were granted write on. Keep destructive tool annotations honest.

**Inputs are bounded.** Every MCP tool argument has a zod schema with lengths and enums, see the top of `server/mcp-server.mjs`. Lists are capped and return a `complete` flag. URLs attached to tasks must be HTTPS and are stored, never fetched. Repository names are normalized `owner/repo` and are only accepted from the bootstrap, never guessed from a folder name.

**The plugin holds nothing.** No credentials, no memory. The hooks are read only. They load the index at session start or after compaction. They never save, never upload transcripts and never read host credentials. The bootstrap only reads the git origin. Any hook output that could become instructions goes through our own formatter.

**Secrets never touch the repo or the chat.** `.env` and `.env.*` are ignored except `.env.example`. Do not paste tokens, keys or Keychain contents into commits, docs, tests or PR text. Tests run against PGlite and need no cloud credentials. CI does not deploy or migrate.

**HTTP hygiene.** `api/mcp` sets `Cache-Control: no-store`, answers 401 with a `WWW-Authenticate` header that points at the resource metadata, and 403 when the grant is gone. `vercel.json` sets `nosniff`, `no-referrer` and `X-Frame-Options: DENY`. Keep those when you add routes.

**The consent page is the only place a grant is created.** It shows exactly what is being asked, defaults to the least access, and returns the code to the app on approval. Deny leaves no grant behind. Do not add shortcuts that skip it.

## Checklist for a change

- [ ] New table: RLS on, `revoke all`, owner policy, agent policy if agents may reach it, indexes for the policy predicates.
- [ ] New function: `security definer set search_path = ''`, fully qualified names, revoke from `public, anon`, grant to `authenticated`, every branch checks ownership or grant.
- [ ] New MCP tool: zod schema with bounds, correct `readOnlyHint` and `destructiveHint`, scope argument explicit, grant checked in the service before the query, error mapped in `errorText`.
- [ ] Tests in `tests/*.test.mjs` that run the migration in PGlite and prove: another owner cannot read or write, an agent without the grant is denied, a revoked grant is denied, a retry is idempotent, a stale revision conflicts, anonymous gets nothing.
- [ ] `npm test` and `npm run build` pass.
- [ ] Nothing in the diff contains a key, a token or a real user's data.

## Where the evidence lives

- `tests/agent-connections.test.mjs`, `tests/database.test.mjs`, `tests/tasks.test.mjs`, `tests/delete.test.mjs` are the isolation tests. Copy their `call(claims, sql)` pattern to run SQL as a given user or agent.
- `tests/mcp.test.mjs` covers token validation and tool contracts.
- `docs/memory-and-storage.md` and `docs/tasks-and-handoffs.md` explain why the boundaries are drawn where they are.
