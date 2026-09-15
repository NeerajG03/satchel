# Satchel pilot: consolidated administrator request

Verified against official documentation and the existing Satchel packages on 2026-09-11. This request covers the current memory pilot, including explicit writes and lifecycle hooks. It does not request unrelated connectors or blanket permission to install arbitrary plugins.

## Request to forward

Please enable Satchel for Neeraj's pilot use in the Claude Team workspace and, if applicable, the company's ChatGPT/Codex workspace. Please check plugin availability, connector access, tool permissions, and hook restrictions together so that connector creation is not the only completed step.

### Shared connection details

| Field | Value |
| --- | --- |
| Name | Satchel |
| Remote MCP endpoint | `https://satchel-pi.vercel.app/api/mcp` |
| Transport | Streamable HTTP over HTTPS |
| Authentication | Individual OAuth; each user signs into Satchel and selects allowed memory scopes |
| OAuth issuer | `https://prpgcrwteepcunizdcut.supabase.co/auth/v1` |
| Source repository | `https://github.com/NeerajG03/satchel` (private) |
| Intended initial user | Neeraj; use an existing suitable role/group where individual assignment is unavailable |
| Data access | Saved personal memories and individually authorized projects; names/descriptions automatically, more info on request |

Satchel supports OAuth discovery and dynamic client registration. Leave optional manually supplied OAuth client ID/secret fields empty initially. Do not enter the GitHub sign-in application's client secret: that is a different integration. Each person must authorize their own Satchel connection; a shared administrator login should not be used as the team's memory identity.

### Claude Team: action required now

An Owner or Primary Owner should:

1. Open **Organization settings → Connectors → Add → Custom → Web**.
2. Add **Satchel**, using the MCP endpoint above.
3. Make it available to Neeraj under the workspace's supported access controls. Confirm it can be selected in Claude Code cloud sessions.
4. If tool policies are configured, permit the complete current tool list below, including project selection and explicit save/correct/delete. Writes may continue to require user confirmation.
5. Confirm organization policies allow the uploaded Satchel plugin and its lifecycle hooks in the intended Code environment. The account already has `satchel@My Uploads` version `0.1.1`; a second upload is not requested.

At the last UI check, the plugin was enabled and its skill, connector, and two hook groups were recognized. Its connector showed **Not added**, with **Connect disabled**. After owner registration, Neeraj connects individually in **Customize → Connectors**, completes Satchel OAuth, and selects personal/project scopes and write permission.

The plugin upload and connector registration do not prove that a cloud Code runtime receives the package or executes its hooks. Satchel's implementation/testing work must verify that separately. If repository configuration or an environment setup is needed for package delivery, we will prepare it in the Satchel test repository; the request does not authorize modifying unrelated company repositories.

### Codex desktop / CLI: conditional policy check

The personal local Satchel installation has already completed OAuth and memory tests. No additional admin action has been demonstrated as necessary for that installation. If Neeraj uses a managed company workspace or device, please check all of the following together:

1. Satchel is available to the intended user/role wherever workspace plugin controls apply, and any required MCP/app connection is also available.
2. Managed configuration does not disable plugins or reject Satchel's approved installation source. The current local plugin identity is `satchel@personal`; its MCP server key is `satchel`. Review/allow that exact plugin identity and endpoint under plugin-scoped MCP requirements if allowlists are enforced. A future organization-managed installation may use a different marketplace identity and must match the deployed identity.
3. The current approved tool set below is allowed, including explicit writes and project selection.
4. Hook policy permits Satchel's read-only lifecycle hooks. If `allow_managed_hooks_only` is enforced, an administrator must arrange managed deployment of equivalent reviewed hooks/scripts; ordinary plugin installation will not run them. Do not disable the organization's global hook restrictions just to complete this pilot.
5. Where network restrictions apply, allow the MCP service host `satchel-pi.vercel.app` and OAuth issuer host `prpgcrwteepcunizdcut.supabase.co`. Package installation requires access to its approved source; the existing GitHub/Satchel sign-in flow must also remain usable. No inbound laptop port or tunnel is required by the hosted memory service.

The package bootstrap requires Node.js. Its command emits static retrieval instructions; it does not read files, collect transcripts, or hold credentials. User hook trust and individual OAuth are still user-side setup steps, not repeated administrator approvals.

### Hosted ChatGPT / Work: separate from local Codex

If hosted ChatGPT use is also in scope, request authorization to register/enable Satchel's custom remote MCP app and its current actions for Neeraj's role. Workspace plugin availability and app access must both be configured. Individual OAuth remains required.

**Do not import the current package and assume web support.** OpenAI documents imported packages declaring `.mcp.json` servers as desktop-only, even with remote HTTPS URLs. Hosted packaging must reference an existing registered app via `.app.json`. Registering the app does not itself grant user permissions. Satchel's registered OpenAI app ID and hosted package have not yet been created/verified; that engineering work is ours to complete. Web installation also does not deploy local hook scripts. No cloud hook parity is promised by this request.

## Current tools for policy review

| Tools | Effect |
| --- | --- |
| `connection_status`, `list_projects`, `memory_index`, `read_memory`, `load_memory_context` | Read connection permissions, authorized projects, memory metadata or requested details |
| `select_project` | Changes this conversation's active project; it does not expand access or write memory content |
| `save_memory` | Explicitly saves a memory |
| `correct_memory` | Explicitly revises a memory using its current revision |
| `delete_memory` | Explicitly deletes a requested memory using its current revision |

Allowing only tools marked read-only will block `select_project` as well as memory writes. Approve these existing actions explicitly where a custom tool policy is used; keep review for future newly introduced actions.

Hooks load the memory index only on a new conversation/clear and after compaction. There is no ordinary-message or resume refresh, automatic memory save, or transcript ingestion. Claude uses `SessionStart` with `startup|clear|compact` for bootstrap and `clear|compact` for direct MCP; Codex uses `SessionStart` for `startup|clear` and `PostCompact`.

## Completion check

The administrative part is complete when Neeraj can see/install the approved package, start individual Satchel authorization, access all approved tools, and run the reviewed hooks under applicable policies. We then verify a fresh cloud session with temporary test memory: index retrieval, detail read, explicit save/correct/delete, and compaction. Current local success and account upload are not substitutes for that test.

This covers the known permissions for the current pilot. A new service, changed endpoint, new tools, or changed organization policy can require later review; we cannot guarantee that no future approval will ever be needed.

## Sources

- [Claude custom connector setup and Owner requirement](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Claude Code web environments and configuration](https://code.claude.com/docs/en/claude-code-on-the-web)
- [OpenAI managed configuration: plugin sources, MCP identities, and managed hooks](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
- [OpenAI plugin controls: availability, app access, and action policies](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)
- [OpenAI plugin import, desktop-only MCP packages, and registered app references](https://learn.chatgpt.com/docs/enterprise/plugin-management)
