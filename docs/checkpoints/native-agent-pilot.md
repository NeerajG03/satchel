# Native agent pilot — 11 September 2026

This is a working developer pilot, not a completed public-release certification. The original broader [acceptance matrix](../plugin-pilot-design.md) remains useful; unperformed rows below must not be treated as passes.

**Later user decision, 11 September:** per-message loading has been removed. Current packages load only on new conversations/clear and after compaction; resume does not refresh. Bootstrap guidance now requests one fallback attempt per lifecycle event. The runtime evidence below records the earlier configuration; see [current hooks](../memory-hooks.md) for the updated event contract. Cross-client next-turn freshness is no longer promised; use explicit refresh or the next lifecycle load.

## Implemented

- Production MCP at `https://satchel-pi.vercel.app/api/mcp`, with resource discovery, Supabase OAuth/PKCE, scoped consent and revocation.
- Database enforcement for owner, client, grant generation, personal/project scope and read/write capability. Agent sessions cannot use companion grant-management functions.
- Explicit save/correct/delete tools reuse the web app's idempotency, stable-ID and optimistic-revision rules.
- Generated Codex and Claude Code packages with read-only metadata hooks, on-demand detail instructions and a credential-free startup fallback.
- Connections UI in the companion; permission scope is per client identity, not a promise of per-device isolation.

## Runtime evidence

Tested against production, from `/private/tmp/satchel-client-check` outside JEFF's project instructions. Native host OAuth credentials were used without reading or exporting them. Only the temporary personal record `satchel-pilot-fixture` was changed; its ID was `27f569a0-ace5-4e29-9109-9bbb39cfd989`.

| Check | Observed result |
|---|---|
| Codex 0.153.2 OAuth | Native `codex mcp login satchel` completed; authenticated status and personal index tools succeeded |
| Claude Code 2.1.268 OAuth | Native interactive `claude mcp login plugin:satchel:satchel` completed; MCP health reported Connected and reads succeeded |
| Codex hook injection | Fresh session `01a08f3a-47c4-7e00-92fb-10a474c140db` reported an index and correct session key before explicit read calls |
| Claude interactive hook | Session `a49ce4ac-09d1-4137-bcb7-22cdde798539` received an empty personal index before its first answer, then saw the new fixture on the next prompt |
| Cross-client save/read | Codex saved revision 1. A neutral question in Claude caused `read_memory` using the hook's stable ID and returned the value stored only in more info |
| Companion correction | Browser edited the fixture to revision 2. The same Claude session fetched and answered with the new value, identifying the previous value as stale |
| Agent correction | Claude read revision 2 then used `correct_memory` with that revision; the service returned revision 3 |
| Reverse continuity | Fresh Codex session `01a08f43-6b1e-7ae1-adc1-1ed8c96163c8` used the startup fallback and read Claude's revision 3 detail correctly |
| Hosted revocation | Companion revoked the original Codex client. Native Codex transport rejected initialization with `HTTP 403: Connection revoked or unavailable`. Claude's separate connection still read and deleted the test fixture |
| Cleanup | Claude read revision 3, deleted the fixture with that revision, then received an empty personal index with `complete: true` |
| Cold startup failure and recovery | Original Claude `-p` startup did not receive an index. Updated static bootstrap caused a real `load_memory_context` fallback followed by `read_memory`, returning the fixture without the answer in the prompt |
| Claude startup error | Original `SessionStart:startup` MCP error reproduced. Restricting the MCP handler to `clear|compact` removed it; a fresh interactive launch in `/Volumes/Casesensitive/jeff` showed no startup error |
| Source/package checks | Both host validators passed. `npm test`: 44 passed. `npm run build` and `git diff --check` passed |

Raw CLI test output was kept in temporary local files for this run, not committed as product telemetry. The automated tests cover direct SQL/RPC isolation, read-only write denial, revisions, idempotency, grant generation, revoke/reconsent, JWT validation and index completeness. These are database/protocol tests, not a claim of repeated real-host stress testing.

The original Codex client remains visibly revoked as test history. Native Codex OAuth login was run again successfully and registered a new client; no access token or secret was copied into the repository. The hosted backend is commit `84565d6` plus the opaque-authorization-ID fix `3fe682e`; startup handling and setup documentation are commit `2320d8a`. CI passed on the latter. The local Codex development package is `0.1.0+codex.20260911065240`; Claude's local package is `0.1.0` with the updated generated source.

## Honest limits

- Direct hook injection is proven in connected sessions, not on every cold start. A static hook asks the agent to retrieve through MCP when the native server is late. This fallback is visible and separately identified; it must not be described as successful direct hook delivery.
- The default hook budget is 1,800 UTF-8 bytes for serialized index data; larger collections report incomplete loading. There is no persistent offline cache.
- Packages are installed through local development catalogs from the private repository. Clean remote release installation, update and rollback have not been certified.
- Five cold/warm repetitions per host, disabled-plugin negative control, automatic mid-turn compaction, forced network outage, sustained concurrency, OAuth expiry/refresh and a second real user account remain release-hardening work. Database tests cover isolation but are not substitutes for these host-level experiments.
- The companion edit was performed in a desktop browser. The user previously confirmed phone use of the companion; this run does not claim a new physical-phone test.
- Codex CLI was exercised; a fresh Codex desktop task must independently pick up the installed plugin and approve its hooks. Ordinary ChatGPT/Claude mobile chats are outside this pilot.

See [agent setup](../agent-setup.md) for commands, architecture and operational configuration.
