# Decision ledger

As of 18 September 2026. Explicit user statements outrank inherited reports, recommendations, and prototype behavior.

## Agreed direction

| ID | Decision | Basis and implication |
|---|---|---|
| D01 | Product name: Satchel | User selected “Satchel”; private `NeerajG03/satchel` repository created |
| D02 | Continuity across apps, devices, and new chats is the core value | User challenged the need to duplicate frontier-app wrappers and valued centralized context |
| D03 | Hosted service with existing AI plugin platforms is the intended direction | User described the system as hosted and plugin-based and supplied OpenAI/Claude plugin docs |
| D04 | Companion interface for configuring and understanding the setup | User clarified that this supports their agents and server configuration |
| D05 | No personas; no curator needed to start | Direct user decisions; no automatic reintroduction scheduled |
| D06 | Explicit memory and corrections, without a proposal/curation pipeline | Carried through the requested report revisions; task evidence remains distinct |
| D07 | ~~GitHub Issues is the only built-in V1 task source~~ | Superseded by D17 on 16 September 2026 |
| D08 | Satchel's own third-party source plugin system comes later | Backend must permit extension, but V1 does not ship a loader, marketplace, SDK, or sync UI |
| D09 | Dark and light modes are required in the design | Direct user design request; current warm prototype does not yet implement both |
| D10 | Current visual revamp establishes look and feel | User explicitly said functionality and mechanisms remain incomplete |
| D11 | Broad visual changes need research and user vetting | User rejected the previous generic directions and required review before app-wide changes |
| D12 | Collect the discussion and design in this repository | Current request authorizes documentation and artifact collection, not deployment or live data migration |
| D13 | Start with a web companion | User narrowed initial delivery to a web app; native Android packaging and direct phone-chat integration are not first-feature requirements |
| D14 | Make sign-in as simple as possible | User favors GitHub and also raised Google OAuth; GitHub-first is the recommendation, not yet an implemented or irrevocable provider choice |
| D15 | Target no hosting cost for the personal pilot | User asked to use free tiers; this is a budget direction, not a guarantee of unlimited free service or authorization to enable paid overages |
| D16 | Investigate automatic context delivery through native plugin hooks | User wants the agent told how to retrieve context or given relevant context; automatic retrieval does not change explicit-only saving |
| D17 | Supabase is the sole authority for Satchel task state, handoffs and resource metadata | User explicitly selected the self-contained architecture; repositories and external trackers are optional typed links, not task identity |
| D18 | Private Supabase Storage holds task files with a reserve/upload/verify lifecycle | User accepted the Supabase-native review, including separate upload capability, immutable object paths and export of database records plus objects |
| D19 | Tasks have lightweight comments and structured progress updates in addition to handoffs | User explicitly called out ongoing progress and comment updates as useful; comments do not conflict with task edits, while progress atomically advances task state/next action |
| D20 | Task hierarchy and dependencies are explicit same-scope graph edges | Preserves Gig's useful planning model without making display IDs relational; cycles and cross-scope edges are rejected and actionability is derived from live prerequisite state |
| D21 | Every tool refusal names what the agent should change | User asked for this across all tools after an agent retried a valid slug twice against a generic "violates the contract" line. Tool schemas say each rule in words and check cross-field rules before the write. `server/error-text.mjs` holds one entry for every sentence a routine or service raises and every constraint a tool can reach, never shows `error.details`, and tells the agent when the fault is Satchel's own. `tests/error-text-coverage.test.mjs` fails when a new tool, raise or constraint lands without one |
| D22 | A picked-up preference the user has said twice loads at session start | User asked to close the gap where everything Satchel learned on its own was stored but never loaded. Only `preference` rows with `mentions >= 2`, in their own group after confirmed ones and inside the same cap; facts, intents and anything said once stay counted and searchable. Replaces the confirm-to-load path, which was an approval queue. `.claude/skills/satchel-memory/references/decisions.md` has the evidence |

The notebook/hardware style is the current user-supplied visual direction. The particular font, rotated navigation, opening screen, and component behavior still need final decisions. “Your work, with you” is the working tagline proposed during naming; the name was explicitly selected, not a complete brand system.

## Proposed mechanisms, not settled choices

| Proposal | Reason |
|---|---|
| Project identity independent of repository identity | Covers non-code and multi-repo efforts; addresses the user's criticism of the current model |
| Repository links are optional routing, never authorization | A linked GitHub origin may select an already-authorized project for one conversation; projects still work without repositories and may link multiple repositories |
| Repository activation is lifecycle-driven, not model-driven | A short-lived repository hint is consumed by the authenticated MCP hook, so a user preference against model tool calls cannot suppress project memory loading |
| One hosted context service with native integration packages | Fits the intended hosted/plugin direction without a new agent runtime |
| Separate library, installation, connection, and execution-readiness records | Makes skill portability and per-platform setup honest |
| Native Android only if a later required device feature justifies it | Initial web delivery is now agreed; Android packaging is deferred |
| GitHub-first sign-in without repository access for tasks | Login remains identity-only; task storage no longer needs GitHub authorization |
| Plugin startup context plus MCP retrieval tools and skill instructions | Makes relevant retrieval more dependable; verify hooks, authorization and fallback on the actual installed hosts |
| Append-only Supabase handoffs and task events | Keeps continuity evidence atomic with Satchel-owned task revisions |
| Effective-client preview separate from user-authorized export | Avoids confusing denied automatic access with manual sharing |
| Sixty-second cross-device freshness target | An earlier pilot target to validate, not a service guarantee |
| Nine ordinary successful retrievals in ten opportunities | An earlier relevance target; manual search alone does not establish useful continuity |

## Conflicts and supersession

| Earlier statement | Current interpretation |
|---|---|
| JEFF should run providers, personas, crews, worktrees, and queues | Preserve useful knowledge and let existing apps own execution; migration still requires evidence |
| Keep persona scopes and schedule a curator | Superseded by explicit no-persona/no-curator decisions |
| Use a hosted memory pilot, specifically Mem0, then Git fallback | Historical recommendation; no vendor selected or integrated |
| All memory, skills, and tasks must live in a GitHub hub | Recorded in the September 6 handoff, but not reaffirmed as Satchel's final physical storage design after the latest clarification; unresolved |
| Every project is a private repository | Not adopted as the project definition; a repository is a resource |
| `npx skills` is the installation answer everywhere | Historical option; native plugin packaging and surface-specific installation must be resolved |
| “No plugins in V1” applies to every meaning of plugin | Applies to Satchel's own source-extension system; does not rule out distribution through AI app plugin platforms |
| GitHub Issues as task authority | Superseded by D17; GitHub objects are optional external task resources |
| Built-in Notion task support | Still not included; an existing Notion record can be attached as an HTTPS reference without synchronization |
| Font or navigation choice is final because it appears in the prototype | No; prototype establishes visual direction and alternatives |
| Delete all queued sessions because counts are repetitive | Not accepted; preserve and classify before any destructive migration |

## Open decisions

11 September — **current hook frequency:** the user chose automatic memory-index loading only on new conversations (including clear) and after compaction. Per-message loading/freshness checks are removed; ordinary resume does not refresh. A missing startup index may trigger one read-only fallback attempt. Explicit retrieval and memory writes remain available. This supersedes the earlier per-prompt pilot behavior; see [current hooks](memory-hooks.md).

11 September — **skills management deferred:** preserve the [personalized skills-management direction](skills-management-direction.md) for later; do not start implementing it as part of the hook changes.

- Memory/project storage, schema, retention, export, and hosting operations.
- Exact supported platform/account matrix; direct phone-chat integration is a later capability question.
- Private skill package distribution, dependencies, updates, and verification signals.
- Work/personal authorization boundaries and per-app versus per-device grants.
- Project-to-repository/task routing and native app project associations.
- Web-on-phone behavior, optional share-to-save, offline drafts, and recovery; native Android packaging is deferred.
- Native launch/resume routes, default app selection, and coordination semantics.
- Typography, first screen, dark palette, scalable selectors, and accessible navigation.
- Pricing, public distribution, self-hosting, organization collaboration, and remote execution, none of which has been committed.

Name research found another portable AI knowledge project named [Satchel](https://github.com/virgilvox/satchel). The user chose the name after that overlap was reported. The private repository name is decided; domain/trademark availability and public branding work have not been completed.

## Implementation findings: 18 September

The repository-hint staging endpoint remains an intentionally anonymous, write-only bridge because the local lifecycle hook may run before MCP OAuth is ready. This is acceptable only for the private pilot: input is limited to a high-entropy session key plus normalized GitHub repository identity, the request is capped at 1 KiB and exact fields, rows expire after five minutes, and authenticated consumption still checks owner repository links and the current connection grant. Possession of a live session key can still disrupt automatic project selection, and an anonymous endpoint retains denial-of-service exposure. Edge rate controls and alerting are required before broader public exposure. See the [pre-launch security audit](checkpoints/security-audit-2026-09-18.md).

## Implementation findings: 10 September

Codex documents plugin-bundled hooks and `SessionStart` context output, including startup, resume and compaction. Plugin hooks require trust; an MCP startup hook may run before its server is ready. Verify installed-host behavior and retain a retrieval fallback. [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Claude Code documents plugin hook configuration and `SessionStart` output added to context. This establishes a mechanism to test for coding sessions, not universal support in Claude phone chats. [Plugin hooks](https://code.claude.com/docs/en/plugins-reference), [Hook reference](https://code.claude.com/docs/en/hooks).

10 September user decision: memory consists of a name, description and More info. Replace the earlier relevance-selected startup brief with a complete index of names/descriptions in the authorized active scope, delivered by supported hooks; read full details by scoped name when needed. IDs and revisions remain attached. The companion/database implement this record shape and index/detail separation. On 11 September the user authorized personal memory and asked for extensible implementation: For me is now a real personal scope, using the same operations/editor as projects, with typed scopes and separate feature/data-access modules. Hook delivery, agent grants, repository scope and context-capacity handling remain pending. If context cannot be loaded completely, report that accurately and allow retry. Do not upload transcripts or create memories through these hooks. A hook firing and an agent using the right memory are separate acceptance checks. See [memory contract](memory-and-storage.md).

Free-tier evaluation replaces the earlier Render-first preference. Vercel Hobby is for personal, non-commercial use and enforces usage limits. Firebase offers no-cost allowances, but Firebase App Hosting requires the billing-enabled Blaze plan. Select a complete web/API/MCP/auth/storage combination against a zero-cost pilot target; no provider is selected and no billing is enabled. [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Firebase pricing](https://firebase.google.com/pricing), [Firebase App Hosting costs](https://firebase.google.com/docs/app-hosting/costs).
