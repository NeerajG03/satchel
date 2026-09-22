---
name: satchel-apps
description: How a connected app reaches Satchel and what it is allowed to do. Use when changing the OAuth flow, the access-token hook, the consent page, the Apps page, grant columns or the authorize/revoke routines, the MCP HTTP handler, the plugin packages, the lifecycle hooks or the shipped end-user skill. This documents the system for people building it, not for agents using it.
---

# Satchel apps, and why the seam is where it is

An app is a client identity that a person allowed, once, on a consent page. Everything it can ever do is the grant row that consent wrote. The whole product rests on one promise: an app sees only what its owner allowed.

`security` is the trust model in general. This skill is the app-facing half: the OAuth path, the grant shape, the consent and Apps screens, and the plugin that carries it to Claude Code and Codex.

## The one paragraph version

An app registers through Supabase's OAuth server and sends the person to Satchel's consent page. They choose memory scopes and task scopes separately, and write and upload separately again. Allowing writes one `agent_connections` row keyed `(owner_id, client_id)` with a fresh `grant_id`. A custom access-token hook stamps that generation and the Satchel audience into every agent token. `/api/mcp` verifies the token and then builds a Supabase client **with that same token**, so RLS, not the server, decides every row. Revoking rotates the generation, which invalidates every existing token immediately.

## Read this first, then route

| What you are doing | Read |
| --- | --- |
| Changing grant columns, authorize, revoke, or the access helpers | `references/grants.md` |
| Changing the token hook, the HTTP handler, or the consent and Apps screens | `references/oauth.md` |
| Changing the plugin packages, hooks, bootstrap or the shipped skill | `references/plugin.md` |
| Anything at all, before you trust a green test | `references/traps.md` |

## The rules that outrank convenience

**There is no service role key, anywhere.** The MCP handler builds a `supabase-js` client with the publishable key and the caller's own bearer token. Every query runs as that person, under RLS. A server that could read anything would make every policy advisory.

**A companion session is not an agent session.** The distinguishing fact is the OAuth `client_id` claim: absent means the person in their browser, present means an app. Companion-only routines check `auth.jwt()->>'client_id' is null`. Never reuse a companion session as agent authorization.

**The grant generation is the revocation mechanism.** `grant_id` is stamped into the token as `satchel_grant_id` and compared on every access check. Re-consenting mints a new one, so an old access token cannot come back to life by reconnecting.

**Nothing is granted by default.** Consent has to select at least one memory or task scope or it raises `23514`. Write and upload are separate unchecked boxes, and they are forced off when no scope in that group is selected.

**Memory and tasks are four independent switches, not one.** `personal`, `all_projects`/`project_ids`, `can_write` for memory; `task_personal`, `task_all_projects`/`agent_task_grants`, `task_can_write`, `task_can_upload` for tasks. Task permission is not memory permission in either direction.

**"Every project" keeps being true.** It is a flag, not a snapshot of names, so it covers projects that do not exist yet. A blanket grant stores an empty list beside the flag so a stale snapshot can never sit there looking authoritative.

**A permission applies to the app identity, not the installation.** `client_id` is the key. Both the consent page and the Apps page say so out loud, because a person will assume otherwise.

**Nothing proprietary runs on the user's machine.** The plugin is instructions, a hook manifest, a bootstrap script and one URL. Ranking, routing and prompts live on the server.

**One endpoint takes more than an agent token, and only one.** `/api/consolidate` also accepts a companion session (the person pressing "Consolidate now") and an `x-satchel-refresh` header (the developer cron). Both are off by default in `connect()` and switched on for that endpoint alone. A hook endpoint that took a refresh token would be a second way in for no reason.

**Revocation cannot recall what was already read.** Both screens say this plainly. Do not write copy that implies otherwise.

## Where things live

```
supabase/migrations/
  202609110003_agent_connections.sql     the table, authorize/revoke, access helpers, the token hook
  20260920150000_all_projects_grant.sql  all_projects, task_all_projects, authorize_agent_v3
  20260916070509_task_management.sql     agent_task_grants, private.agent_can_access_tasks
  20260922170000_consolidation_schedule.sql  the cron's own OAuth client, its Vault secret, rotation
server/http-handler.mjs        the per-request client and the 401 challenge for /api/mcp
server/agent-token.mjs         verifyAgentToken, verifyCompanionToken, exchangeRefreshToken
server/hook-handler.mjs        connect() for the hook endpoints and /api/consolidate
api/hook-*.mjs, api/consolidate.mjs   the hook endpoints and the background pass
api/mcp.mjs                    the Vercel entry point
api/resource-metadata.mjs      the protected-resource document
src/features/connections/      Consent, Apps, Connected, install commands, repository
scripts/build-plugins.mjs      generates both plugin packages and both marketplace files
integrations/shared/           bootstrap.mjs and the end-user skill in context/
tests/agent-connections.test.mjs, tests/security-audit.test.mjs, tests/mcp.test.mjs
```

## When you change something

1. A new capability is a new column, a new consent control, a new branch in both access helpers, and a new denial test. All four, or it is not done.
2. Never recreate an access helper from an older copy. Read every later migration that touched it first.
3. If you change the deployment, the issuer and resource constants, the SQL token-hook audience and the plugin URL move together, then discovery and token tests run again.
4. Regenerate the plugins with `npm run plugins:build` and commit the output. Edit `integrations/shared`, never the generated copies.
5. `npm test` and `npm run build` pass before a push.
