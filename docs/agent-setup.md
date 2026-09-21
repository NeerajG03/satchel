# Native agent pilot

For workspace approval covering Claude and Codex together, use the [consolidated administrator request](admin-setup-request.md).

Satchel runs at https://satchel-pi.vercel.app. The MCP service is https://satchel-pi.vercel.app/api/mcp. Memory remains in Supabase; local plugins contain only instructions, hook scripts and the service address. There is no laptop tunnel or local memory database.

## Installed on this machine

Codex: `satchel@personal`, generated from `integrations/codex/satchel` and installed through the plugin-creator personal marketplace. Open a fresh task after plugin updates. Review Satchel's hooks in `/hooks`: the command only emits bootstrap guidance; the MCP hook only retrieves metadata. Installing does not automatically trust hooks.

Claude Code: `satchel@satchel-dev`, from the local catalog under `integrations/claude`. Reload or restart Claude after updates. Both hosts have completed their native OAuth login against production. Credentials live in each host's own OAuth storage, never in the package.

Login commands:

```sh
codex mcp login satchel
claude mcp login plugin:satchel:satchel
```

Run Claude login in an interactive terminal. In Satchel's consent page, select personal memory and/or individual projects. Write access is a separate unchecked option. Connections in the web app shows and revokes those grants. A client display name is self-declared; revocation applies to all installations using that client identity.

## Claude account upload and cloud verification status (2026-09-11)

The Claude account UI accepted the existing Claude 0.1.1 package through **Customize → Plugins → Add plugin → Upload plugin**. Package the contents of `integrations/claude/satchel`, including dotfiles, as a ZIP. The manifest must be at `.claude-plugin/plugin.json` inside the archive.

The uploaded `satchel@My Uploads` is enabled in the pilot account. Claude recognized every file in the package, one skill, one connector, and two SessionStart hook groups (`startup|clear|compact` bootstrap and `clear|compact` MCP). Recognition in this UI is not evidence that a Code cloud session executes the hooks. That upload was five files; the package now ships eight, because the skill carries three progressively disclosed reference files alongside `SKILL.md`.

The pilot Team workspace currently shows the Satchel connector as **Not added**, with **Connect disabled**, and no custom-connector creation control. [Anthropic's documented Team setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) requires an Owner or Primary Owner to add it under **Organization settings → Connectors → Add → Custom → Web**, using `https://satchel-pi.vercel.app/api/mcp`. Members then connect individually and authorize their own Satchel scopes. Do not copy local OAuth credentials into a cloud environment.

Cloud OAuth, actual Code-session plugin delivery, startup/compaction execution, and memory read/write verification remain untested pending connector availability. The existing local CLI verification does not cover those cases. Uploading the package alone has not completed cloud setup.

## Use

- Personal memory needs no project. Ask the agent to remember something **in personal memory**, with a name, description and optional more info.
- For project work, ask the agent to list allowed projects and select one for this conversation. Selection never expands its grant and never changes another conversation's selection.
- A project can optionally link one or more GitHub repositories in the companion. In a linked checkout, the lifecycle bootstrap stages the normalized `origin` identity and the authenticated index hook selects that project only if the current connection already has access. Repository linking is routing, never authorization; `select_project` with the staged repository identity remains a fallback when staging fails.
- On an explicit request, a connection with memory-write or task-write capability can use `upsert_project` to create a project and optionally link one GitHub repository atomically. Existing projects require their current revision and must already be in the corresponding writable grant. A newly created project is not added to the grant automatically; authorize it in the companion before selecting it or writing scoped content.
- Names/descriptions load on a new conversation (including clear) and after compaction. There is no per-message refresh or resume hook. Relevant details are fetched with `read_memory` using the index's name and stable ID.
- Explicit saves use an idempotency UUID; corrections and deletions require the current revision. Hooks never save, correct or delete memory on their own. The `Stop` hook reads the turn that just ended out of the host's transcript and sends the person's messages and the assistant's plain text; a memory the router keeps from that arrives unconfirmed and is announced.
- A web/phone edit enters the index on the next lifecycle load or explicit refresh request, not automatically on the next ordinary turn. Existing chat text does not disappear. Ask for a refresh after a correction.

## Startup behavior and limits

Claude can start `SessionStart` before MCP is available. Its command hook stages the normalized repository without credentials, while the MCP `SessionStart` hook remains restricted to `clear|compact`. On a cold launch, the bootstrap may ask the agent to make one lifecycle fallback retrieval if the index did not arrive; there is no hook on ordinary prompts.

Codex uses `SessionStart` for startup/clear and `PostCompact` for compaction. Both hosts exclude resume and `UserPromptSubmit`. Hooks remain subject to host trust/settings and connection availability. See [current event behavior](memory-hooks.md).

The hook includes authorized personal memory plus the conversation's explicitly selected project. Its serialized index budget is 1,800 UTF-8 bytes, deliberately conservative relative to host context limits. If the index exceeds that budget, or database pagination is incomplete, it reports incomplete loading and directs explicit scoped retrieval. Full detail is never automatically injected. This pilot limit needs usability testing with larger memory collections.

## Install for anyone

This public repository is the catalog. `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` at the root point at the generated packages under `integrations/`.

```sh
# Claude Code
claude plugin marketplace add NeerajG03/satchel
claude plugin install satchel@satchel
claude mcp login plugin:satchel:satchel

# Codex
codex plugin marketplace add NeerajG03/satchel
codex plugin add satchel@satchel
codex mcp login satchel
```

The login command opens the consent page in the browser. After Allow, start a fresh session so the hooks load the index. The Apps page in the web app shows the same commands when nothing is connected.

## Build and publish

```sh
npm ci
npm run plugins:build
claude plugin validate .
claude plugin validate integrations/claude/satchel
```

`build-plugins.mjs` generates both packages from `integrations/shared` and writes the two marketplace files at the repository root. Commit all of it. Installing reads `main` directly, so a merged commit is a release once the version in `build-plugins.mjs` is bumped. Edit shared source and rebuild, never the generated copies. The local `satchel-dev` directory catalog under `integrations/claude` still works for development.

The bootstrap requires Node.js on PATH. Current validation is on macOS; other operating systems and ordinary mobile ChatGPT/Claude chats are not validated targets.

## Hosted configuration

- Vercel deploys the existing Vite app plus Node functions under `api/`; no Next.js migration is required for this implementation.
- Apply the existing migrations, including `202609110003_agent_connections.sql`.
- Keep `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in deployment configuration. There is no service-role key in the MCP handler.
- Enable Supabase OAuth server, `/authorize` as authorization path, and dynamic client registration.
- Enable the custom access-token hook `public.satchel_access_token_hook`, executable only by `supabase_auth_admin`.
- The hook binds OAuth tokens to a current grant generation and to both the Satchel resource audience and Supabase's `authenticated` audience. The MCP handler verifies signature, issuer, expiry, audience, client and grant claims. RLS independently enforces active grants on database access.
- Revocation rotates the grant generation immediately, then requests provider OAuth cleanup. Earlier access tokens cannot become valid again merely by reconsenting. Existing chat copies cannot be recalled.

The production issuer/resource constants currently identify this pilot deployment. A different deployment must update those constants, SQL token-hook audience and plugin URL together, then verify discovery and token tests.
