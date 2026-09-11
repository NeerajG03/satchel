# Plugin pilot: distribution and acceptance design

11 September 2026. This document preserves the original research and acceptance proposal. Implementation has since begun: the hosted MCP endpoint, scoped OAuth grants, connection UI, explicit writes, and both native packages now exist. See [installation and operation](agent-setup.md) and [runtime evidence](checkpoints/native-agent-pilot.md) for current facts; future-tense passages below describe the original proposal, not current deployment status.

## What we should prove

After installing and connecting Satchel in Codex and Claude Code, a fresh conversation receives the authorized memory names and descriptions before answering. It retrieves more info by explicit scope and name only when relevant. A phone edit is visible on the next refresh, and revoking one connection stops that connection's future reads while the other continues working.

Start read-only. The companion already provides writes, so it can exercise cross-platform continuity without introducing agent write permissions at the same time. Agent saves and corrections follow this acceptance gate.

## What is served where

| Part | Proposed location | How it changes |
|---|---|---|
| Companion and connection-management UI | Existing Vercel deployment | Web deployment |
| Satchel MCP endpoint | A new HTTPS route backed by a Vercel Node function | Backend deployment, with an explicit API compatibility version |
| Memory, project and connection grants | Supabase | Reviewed migrations and normal authenticated operations |
| Plugin instructions, manifests and hook configuration | Versioned source in the private Satchel repository; host-specific build outputs | Plugin release and host update/install |
| Access and refresh credentials | Host-managed OAuth storage | Login, refresh and revoke; never plugin source |

The plugin is a small installed package. The memory stays in the hosted database. Editing memory never requires reinstalling the plugin. A private package recipient needs repository access to obtain it, then separately authenticates to their own Satchel account. Sharing the package shares neither the publisher's account nor private memory.

Vercel Functions supply the proposed server runtime; this is an extension of the existing deployment, not a requirement to migrate the web UI to Next.js. Verify MCP HTTP transport behavior, cold starts and function limits in the initial spike. Prefer stateless request handling: a restarted instance must not lose authorization state or mix scopes. [Vercel Functions](https://vercel.com/docs/functions).

The proposed MCP URL will be finalized during implementation; it does not exist yet. No laptop tunnel is part of the deployed design.

## Packaging and installation

For Codex, use the requested plugin-creator scaffold and validator: `.codex-plugin/plugin.json`, skills, `.mcp.json`, and default-discovered `hooks/hooks.json`. The bundled skill rejects a manifest-level `hooks` field despite its sample mentioning one; omit it and use default discovery. Current OpenAI docs also describe a newer portable format, but adopting that is unnecessary for this pilot. Local/personal marketplaces support development without public-directory submission. Public distribution has a separate review route. [OpenAI packaging](https://developers.openai.com/plugins/build/plugins).

Initial Codex development uses the skill's personal-marketplace default, preserving existing entries. Use its cachebuster/reinstall helper for changes, then a fresh task. Do not configure a repository marketplace until that distribution destination is selected. Source can be maintained in Satchel and copied into a validated local development package; there should be one authoritative implementation, not hand-maintained divergent copies. [Local skill](/Users/neerajgopalakrishnan/.codex/skills/.system/plugin-creator/SKILL.md).

Claude Code gets its own `.claude-plugin/plugin.json`, `.mcp.json`, skills and hook configuration. Use `claude --plugin-dir <built-plugin-directory>` for development and `claude plugin validate <built-plugin-directory>` before testing. These are command templates, not ready Satchel installation commands. [Claude plugin development](https://code.claude.com/docs/en/plugins).

After local acceptance, test an actual private Git-backed distribution: the host downloads a pinned release containing its package and catalog. Claude's catalog is `.claude-plugin/marketplace.json`; Codex's repository catalog is `.agents/plugins/marketplace.json`. These are separate native catalogs, not a new Satchel marketplace product. Private Claude installs use Git credentials; test manual updates before relying on background updates. A separate public connector repository can be introduced when external users need distribution without access to the product source. [Claude distribution](https://code.claude.com/docs/en/plugin-marketplaces), [Codex distribution](https://developers.openai.com/plugins/build/plugins).

Both packages should be generated from shared instructions and tool contracts, with thin host adapters. Validate the installed copy as well as source files; package caching and omitted files can otherwise make development tests misleading. Package releases must exclude `.env`, private memory, test credentials and unrelated product files. Pin package versions and document rollback independently from backend rollback.

## Hooks: the first uncertainty to test

Codex documents `SessionStart`, `UserPromptSubmit`, plugin hooks, trust review and MCP tool hooks. An MCP hook requires an existing connection. Startup may precede connection readiness. Hook output can also spill to a file above its context threshold. [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Claude Code likewise supports command and MCP tool hooks; MCP hooks cannot initiate OAuth. Its startup `SessionStart` MCP hook is skipped before servers are available. Plugin server names are scoped, so a bare server name is insufficient. [Claude hooks](https://code.claude.com/docs/en/hooks).

**Preferred experiment:** use a synchronous `UserPromptSubmit` MCP hook to fetch the authorized index before each user turn. Also test session resume and compaction explicitly. Use a tiny static bootstrap instruction to explain connection/setup state. Do not make the first-turn guarantee depend solely on `SessionStart`.

This is a candidate mechanism, not a proven timing guarantee. If the native connection is late or the event cannot deliver the complete index, record a failed automatic-loading test. Explicitly asking the agent to call an index tool is a useful fallback, but does not pass the automatic-hook requirement.

Only if needed, add a small command-hook helper that obtains the index independently of MCP startup. That helper introduces credential storage and refresh responsibilities; it must use a supported login flow and its own scoped authorization, never scrape the host's credential store. Evaluate that cost after the synthetic test, rather than assuming a local daemon or CLI is necessary.

For initial testing, fetch current metadata each turn; do not add a persistent private-memory cache. A phone edit should be picked up before the next user turn, not silently injected into an already-running answer. Later caching must have revision checks and explicit invalidation.

## Index and scope contract

The hook returns all names and descriptions in the **enabled personal scope and explicitly active project**, within that connection's grant. Permission to access several projects does not mean injecting all their memories. Selecting a project in the phone UI must not change every agent conversation's active project.

Default to personal only when the user granted it. Project selection is explicit and session-bound. A directory can suggest a previously confirmed binding later; it cannot grant access or choose a project by a matching folder name. Concurrent conversations keep independent selections. The server checks authorization again regardless of supplied session or project identifiers.

Proposed read tools:

| Tool | Result |
|---|---|
| `memory_index(scope)` | IDs, scope, names, descriptions, revisions and a completeness indicator; no more info |
| `read_memory(scope, name)` | Current detail for exactly one scoped name, with ID and revision |
| `connection_status()` | Effective allowed scopes and connection state, without credentials |

A hook adapter formats the index as context using fixed output fields. Memory text is quoted data; it cannot supply hook decisions, executable commands or permission overrides. More info stays out of bootstrap context. Scope remains explicit when personal and project names collide. Rename/reuse handling must retain the existing stable-ID protection.

Set a documented index budget and test its boundary on both hosts. Fetching a complete API response is not proof the entire index reached the model. An oversized index must report incomplete loading and offer narrower scope or explicit retrieval; never quietly drop entries or claim all memory loaded. Start with a small fixture, then deliberately exceed the host limit.

## Authentication and revocation

Preferred first implementation: Supabase OAuth 2.1 plus a Satchel consent page and grant records. Supabase documents MCP discovery, registration, PKCE and refresh support, but Satchel must implement its own MCP service and authorization UI. [Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication).

Consent should say which connection is asking, whether personal memory is included, which projects it can read, and how to revoke. Start with read-only grants. Treat a self-declared client display name as descriptive, not verified identity. The app manages effective authorization even when a host allows a tool automatically.

The OAuth compatibility spike must validate discovery, client registration, exact redirects, PKCE, token issuer/audience and refresh in both real clients. OpenAI requires MCP resource metadata and resource-bound token validation. Do not advertise metadata capabilities the authorization server has not implemented. [OpenAI authentication](https://developers.openai.com/plugins/build/auth). Claude supports browser OAuth for HTTP MCP servers. [Claude MCP authentication](https://code.claude.com/docs/en/mcp).

Supabase's documented default audience and OIDC scopes are not automatically an application permission model. Confirm the required resource audience and database token compatibility; use documented token customization where necessary. Database permissions require RLS. [Supabase token security](https://supabase.com/docs/guides/auth/oauth-server/token-security).

Current Satchel policies deliberately deny OAuth-client tokens using the `client_id` condition in `202609100001_foundation.sql`. Preserve companion access and add narrowly tested agent grant enforcement. Do not remove that condition and give every signed-in agent full account access. Check both MCP requests and direct database/RPC attempts. Never use a browser session or service-role key as a plugin credential.

Resolve grant identity against authenticated client/session claims before promising per-device revoke. A client ID alone is not necessarily one installation. If the provider cannot distinguish two installations of the same client, initially label revocation honestly as applying to that client, or implement a verified connection binding. Independent Codex/Claude revocation is an acceptance requirement.

Every read must consult current grant state, including with a still-unexpired access token. Revocation stops future disclosure; it cannot erase content already sent to an existing conversation. Reauthorization must not silently restore broader access.

## Acceptance tests

Use synthetic records and isolated fresh conversations outside the JEFF workspace. Existing chat history and JEFF's memory mechanisms would contaminate this experiment. Record exact host/app versions, plugin revision, hook event/outcome, request IDs, returned record IDs/revisions and latency. Do not log tokens or private memory bodies.

| Test | Pass condition |
|---|---|
| Synthetic hook, first | Fresh Codex and Claude sessions receive a marker from the hook before the first answer; no real credentials or memory needed |
| Cold and warm startup | Repeat each at least five times per host; every connected, trusted run loads the full fixture before answering |
| Negative control | With plugin disabled and a new conversation, the model does not know the randomized fixture answer |
| Metadata vs. detail | An ordinary relevant request triggers lookup from the index; an answer present only in more info requires a recorded detail call |
| Irrelevant request | Index may load, but unrelated full memory is not fetched |
| Personal/project isolation | Same name in personal, Project A and forbidden Project B resolves correctly; B is absent even from summaries and errors |
| Parallel conversations | Two active projects in two conversations cannot overwrite each other's selection |
| Phone edit | Change the fixture on the phone; each host's next turn retrieves the new description/detail revision |
| Resume/compaction | Necessary current index reaches the next response, including automatic compaction mid-turn where supported |
| Revocation | Revoke one connection on the phone; old access/refresh attempts cannot obtain data through MCP or direct RPC; other connection and companion still work |
| Failure states | Missing login, denied consent, disabled/untrusted hook, timeout and unavailable server produce honest setup/unavailable state, never fabricated successful loading |
| Budget/injection | Oversized indexes are visibly incomplete; adversarial memory text cannot alter scope, hook decisions or trigger commands |
| Packaged install/update | Clean installation outside the source checkout works; version update and rollback are observable; no developer absolute paths |
| Hosted independence | Clients connect directly to hosted services; shut down local development servers and verify reads still work |

Use neutral prompts that do not contain the fixture answer or instruct the agent which tool to call. First demonstrate explicit calls for debugging; separately score automatic retrieval. Keep model-choice, tool-permission and hook-trust settings in the evidence so success is reproducible.

## Build order and deliverable

1. Build synthetic host packages to settle hook timing, namespacing, output parsing and complete index delivery. Validate using the Codex skill and Claude validator. No production memory access in this step.
2. Prove hosted OAuth and read-only grants with a synthetic fixture account; add connection consent/status/revoke to the companion. Resolve token audience and connection identity before opening database access.
3. Connect both native packages to the same deployed read service. Run the acceptance matrix, then the phone correction and revoke demonstration.
4. Test private package distribution from a pinned release. Only after this checkpoint add explicit agent writes with existing revision and idempotency semantics.

Deliverable: two validated installable packages, one deployed authenticated read service, connection management in Satchel, and a results sheet showing exactly which automatic-loading behavior works in each host. No public-directory listing, universal mobile-chat support, skill marketplace, transcript collection or agent orchestration is implied.

Local CLI versions observed during research: Codex `0.153.2`; Claude Code `2.1.267`. The Codex desktop build and its actual hook behavior must be recorded separately during testing. Documentation support is not runtime verification.
