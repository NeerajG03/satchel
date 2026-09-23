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

**Agents cannot delete tasks or projects.** Only a person can. Agents can forget a memory only within a scope they were granted write on. Keep destructive tool annotations honest. The system itself never deletes a memory: consolidation and the web app's Forget end it with a reason, and `restore_memory` brings it back. So does an agent's `forget_memory`: nothing an agent can call destroys a memory.

**Inputs are bounded.** Every MCP tool argument has a zod schema with lengths and enums, see the top of `server/mcp-server.mjs`. Lists are capped and return a `complete` flag. URLs attached to tasks must be HTTPS and are stored, never fetched. Repository names are normalized `owner/repo` and are only accepted from the bootstrap, never guessed from a folder name.

**The plugin holds one credential and no memory.** As of 0.3.0 the hooks are command scripts with their own OAuth client, stored at `~/.satchel/credentials.json` mode 0600. It is a separate connection from the agent's, with its own row in `agent_connections` and its own Revoke button, so a leaked hook credential is revoked without touching the agent and refreshing it cannot rotate the host's own token. Never read the host's credential store; that was considered and rejected for exactly that reason.

**The hooks send the turn, and only the turn, and never read a file to get it.** `session-start.mjs` sends a session key, an event name and a normalized `owner/repo` read from the git origin. `retrieve.mjs` sends the prompt the host handed it. `capture.mjs` sends the `last_assistant_message` the host handed it, and a commit count from `git rev-list --count HEAD`: a number, never a sha, a message or a path. No script reads `transcript_path`, and `tests/plugin-hooks.test.mjs` asserts that none of them so much as mentions it, because 0.3.0 did read it for one afternoon on a false premise. Hooks never save memory on their own, and any hook output that could become instructions goes through our own formatter.

**Conversations are stored, for 30 days, and nobody else can read them.** Since v2.5 both halves of every turn go into `documents` and `document_turns`, so a later pass can re-read them. That is the largest privacy surface in the product, and four things hold it:

- Neither table has any grant, not even `select`. An agent connection is `authenticated` too, so a grant would let any connection read every session regardless of its projects. Reads go through owner-scoped definer routines.
- `recent_documents` refuses any token with a `client_id`. Listing conversations is for the person in their browser, never for an app acting for them.
- Retention is a real delete: `expire_documents()` runs on every write and returns a row count, so it can be tested rather than trusted.
- `capture = false` stops both the document and the window. The setting is about whether the conversation is kept at all.

**What people paste is scrubbed before it is kept.** `server/secrets.mjs` runs on the prompt and the reply in `hook-handler.mjs`, before the document, the window, the embedder, the injection log or the trace sees them. A new place that takes conversation text from a hook has to go through it too. Its tests build every fake credential at run time, so no literal key shape ever lands in the repo.

**A background job gets its own client, never a blanket key.** The developer cron runs as the person through a separate OAuth client whose refresh token sits in Supabase Vault. `consolidation_credentials` has no grants and holds the secret's id, not the secret. The token rotates on every use. Only a definer routine can read it. A job with a key that reads everyone would be the service role key under another name.

**No anonymous routine may change someone's state.** The first design for reporting a refused cron credential was a routine anon could call, which would have let anyone switch off anyone's job. `tests/security-audit.test.mjs` fails on an anon-executable routine, and it caught that one. The refusal is read from pg_net's own response log instead.

**`private.attribute()` is granted to `authenticated`, and that is safe.** It writes transaction-local settings (trace id, document id, reason) that the `memory_events` trigger reads. It cannot change which rows a caller may touch, and `private.attribute()` does not touch `actor`, which `private.memory_actor()` derives from the JWT through `private.task_actor()`. So a caller can label its own change but cannot claim to be someone else. (`memory_actor` also reads a `satchel.actor` setting first; nothing sets it today, and anything that ever does has to be a definer routine.)

**Secrets never touch the repo or the chat.** `.env` and `.env.*` are ignored except `.env.example`. Do not paste tokens, keys or Keychain contents into commits, docs, tests or PR text. Tests run against PGlite and need no cloud credentials. CI does not deploy or migrate.

**HTTP hygiene.** `api/mcp` sets `Cache-Control: no-store`, answers 401 with a `WWW-Authenticate` header that points at the resource metadata, and 403 when the grant is gone. `vercel.json` sets `nosniff`, `no-referrer` and `X-Frame-Options: DENY`. Keep those when you add routes.

**The consent page is the only place a grant is created.** It shows exactly what is being asked, defaults to the least access, and returns the code to the app on approval. Deny leaves no grant behind. Do not add shortcuts that skip it.

## Checklist for a change

- [ ] New table: RLS on, `revoke all`, owner policy, agent policy if agents may reach it, indexes for the policy predicates. If it holds conversation text, no grants at all and a definer read.
- [ ] New function: `security definer set search_path = ''`, fully qualified names, revoke from `public, anon`, grant to `authenticated`, every branch checks ownership or grant.
- [ ] New MCP tool: zod schema with bounds, correct `readOnlyHint` and `destructiveHint`, scope argument explicit, grant checked in the service before the query, every refusal it can reach listed in `server/error-text.mjs` and the tool added to `TOOL_ROUTINES` in `tests/error-text-coverage.test.mjs`. A new constraint or raised sentence needs its line there too, or that test fails. Never show `error.details`: a check violation puts the whole failing row in it.
- [ ] Tests in `tests/*.test.mjs` that run the migration in PGlite and prove: another owner cannot read or write, an agent without the grant is denied, a revoked grant is denied, a retry is idempotent, a stale revision conflicts, anonymous gets nothing.
- [ ] A migration the new code depends on is applied to production before the code is pushed.
- [ ] `npm test` and `npm run build` pass.
- [ ] Nothing in the diff contains a key, a token or a real user's data.

## Where the evidence lives

- `tests/agent-connections.test.mjs`, `tests/database.test.mjs`, `tests/tasks.test.mjs`, `tests/delete.test.mjs` are the isolation tests. Copy their `call(claims, sql)` pattern to run SQL as a given user or agent.
- `tests/mcp.test.mjs` covers token validation and tool contracts.
- `docs/memory-and-storage.md` and `docs/tasks-and-handoffs.md` explain why the boundaries are drawn where they are.
