# Native agent pilot

Satchel runs at https://satchel-pi.vercel.app. The MCP service is https://satchel-pi.vercel.app/api/mcp. Memory remains in Supabase; local plugins contain only instructions, hook scripts and the service address. There is no laptop tunnel or local memory database.

## Installed on this machine

Codex: `satchel@personal`, generated from `integrations/codex/satchel` and installed through the plugin-creator personal marketplace. Open a fresh task after plugin updates. Review Satchel's hooks in `/hooks`: the command only emits bootstrap guidance; the MCP hook only retrieves metadata. Installing does not automatically trust hooks.

Claude Code: `satchel@satchel-dev`, from the local catalog under `integrations/claude`. Restart Claude after updates. Both hosts have completed their native OAuth login against production. Credentials live in each host's own OAuth storage, never in the package.

Login commands:

```sh
codex mcp login satchel
claude mcp login plugin:satchel:satchel
```

Run Claude login in an interactive terminal. In Satchel's consent page, select personal memory and/or individual projects. Write access is a separate unchecked option. Connections in the web app shows and revokes those grants. A client display name is self-declared; revocation applies to all installations using that client identity.

## Use

- Personal memory needs no project. Ask the agent to remember something **in personal memory**, with a name, description and optional more info.
- For project work, ask the agent to list allowed projects and select one for this conversation. Selection never expands its grant and never changes another conversation's selection.
- Names/descriptions are fetched before prompts when the host's MCP connection is ready. Relevant details are fetched with `read_memory` using the index's name and stable ID.
- Explicit saves use an idempotency UUID; corrections and deletions require the current revision. Hooks never write memory or collect transcripts.
- A web/phone edit becomes available on the next turn or retrieval. Existing chat text does not disappear. Ask for a refresh after a correction.

## Startup behavior and limits

Claude starts `SessionStart` before MCP is available. Its startup hook therefore emits static retrieval guidance, with no network or credentials. The MCP `SessionStart` hook is restricted to `clear|compact`. `UserPromptSubmit` fetches metadata normally; if the connection is late, the bootstrap tells the agent to retrieve the index through MCP before answering, or clearly report unavailability. This fallback worked in a real cold `claude -p` run. It is agent-executed retrieval, **not proof of direct hook injection on every cold launch**.

Codex uses the same fallback plus `SessionStart`, `UserPromptSubmit` and `PostCompact` MCP hooks. Hooks remain subject to host trust/settings and connection availability. No universal first-turn guarantee is claimed.

The hook includes authorized personal memory plus the conversation's explicitly selected project. Its serialized index budget is 1,800 UTF-8 bytes, deliberately conservative relative to host context limits. If the index exceeds that budget, or database pagination is incomplete, it reports incomplete loading and directs explicit scoped retrieval. Full detail is never automatically injected. This pilot limit needs usability testing with larger memory collections.

## Build and private distribution

```sh
npm ci
node scripts/build-plugins.mjs
claude plugin validate integrations/claude/satchel
claude plugin marketplace add ./integrations/claude
claude plugin install satchel@satchel-dev
```

Use an absolute clone path if invoking marketplace commands outside the repository. The catalog above is a local development catalog, not an independently downloadable public release. A second user currently needs access to the private repository and a local clone. Clean remote install/update/rollback remains a separate release gate.

For Codex, use the `plugin-creator` scaffold to register a personal `satchel` package, then copy the generated package to that registered source. The build script accepts the destination as its optional argument. Use the skill's `read_marketplace_name.py`, `update_plugin_cachebuster.py`, and `codex plugin add satchel@personal` update flow; do not hand-edit marketplace configuration. Re-review changed hooks in a fresh client.

Both packages are generated from `integrations/shared`; edit shared source and rebuild, rather than editing generated copies. The bootstrap requires Node.js on PATH. Current validation is on macOS; other operating systems and ordinary mobile ChatGPT/Claude chats are not validated targets.

## Hosted configuration

- Vercel deploys the existing Vite app plus Node functions under `api/`; no Next.js migration is required for this implementation.
- Apply the existing migrations, including `202609110003_agent_connections.sql`.
- Keep `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in deployment configuration. There is no service-role key in the MCP handler.
- Enable Supabase OAuth server, `/authorize` as authorization path, and dynamic client registration.
- Enable the custom access-token hook `public.satchel_access_token_hook`, executable only by `supabase_auth_admin`.
- The hook binds OAuth tokens to a current grant generation and to both the Satchel resource audience and Supabase's `authenticated` audience. The MCP handler verifies signature, issuer, expiry, audience, client and grant claims. RLS independently enforces active grants on database access.
- Revocation rotates the grant generation immediately, then requests provider OAuth cleanup. Earlier access tokens cannot become valid again merely by reconsenting. Existing chat copies cannot be recalled.

The production issuer/resource constants currently identify this pilot deployment. A different deployment must update those constants, SQL token-hook audience and plugin URL together, then verify discovery and token tests.
