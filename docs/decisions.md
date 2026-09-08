# Decision ledger

As of 8 September 2026. Explicit user statements outrank inherited reports, recommendations, and prototype behavior.

## Agreed direction

| ID | Decision | Basis and implication |
|---|---|---|
| D01 | Product name: Satchel | User selected “Satchel”; private `NeerajG03/satchel` repository created |
| D02 | Continuity across apps, devices, and new chats is the core value | User challenged the need to duplicate frontier-app wrappers and valued centralized context |
| D03 | Hosted service with existing AI plugin platforms is the intended direction | User described the system as hosted and plugin-based and supplied OpenAI/Claude plugin docs |
| D04 | Companion interface for configuring and understanding the setup | User clarified that this supports their agents and server configuration |
| D05 | No personas; no curator needed to start | Direct user decisions; no automatic reintroduction scheduled |
| D06 | Explicit memory and corrections, without a proposal/curation pipeline | Carried through the requested report revisions; task evidence remains distinct |
| D07 | GitHub Issues is the only built-in V1 task source | Direct user scope decision; Notion is not provided by Satchel |
| D08 | Satchel's own third-party source plugin system comes later | Backend must permit extension, but V1 does not ship a loader, marketplace, SDK, or sync UI |
| D09 | Dark and light modes are required in the design | Direct user design request; current warm prototype does not yet implement both |
| D10 | Current visual revamp establishes look and feel | User explicitly said functionality and mechanisms remain incomplete |
| D11 | Broad visual changes need research and user vetting | User rejected the previous generic directions and required review before app-wide changes |
| D12 | Collect the discussion and design in this repository | Current request authorizes documentation and artifact collection, not deployment or live data migration |

The notebook/hardware style is the current user-supplied visual direction. The particular font, rotated navigation, opening screen, and component behavior still need final decisions. “Your work, with you” is the working tagline proposed during naming; the name was explicitly selected, not a complete brand system.

## Proposed mechanisms, not settled choices

| Proposal | Reason |
|---|---|
| Project identity independent of repository identity | Covers non-code and multi-repo efforts; addresses the user's criticism of the current model |
| One hosted context service with native integration packages | Fits the intended hosted/plugin direction without a new agent runtime |
| Separate library, installation, connection, and execution-readiness records | Makes skill portability and per-platform setup honest |
| Responsive web first, native Android when device features justify it | Provides a phone experience without assuming two application builds immediately |
| GitHub issue comments as portable handoff records | Keeps task state and work evidence near their authority |
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
| Built-in Notion task support | Superseded by GitHub-only V1; existing external work remains outside the integration |
| Font or navigation choice is final because it appears in the prototype | No; prototype establishes visual direction and alternatives |
| Delete all queued sessions because counts are repetitive | Not accepted; preserve and classify before any destructive migration |

## Open decisions

- Memory/project storage, schema, retention, export, and hosting operations.
- Exact supported platform/account matrix, especially phone reads and writes.
- Private skill package distribution, dependencies, updates, and verification signals.
- Work/personal authorization boundaries and per-app versus per-device grants.
- Project-to-repository/task routing and native app project associations.
- Android packaging, share-to-save, offline drafts, and recovery behavior.
- Native launch/resume routes, default app selection, and coordination semantics.
- Typography, first screen, dark palette, scalable selectors, and accessible navigation.
- Pricing, public distribution, self-hosting, organization collaboration, and remote execution, none of which has been committed.

Name research found another portable AI knowledge project named [Satchel](https://github.com/virgilvox/satchel). The user chose the name after that overlap was reported. The private repository name is decided; domain/trademark availability and public branding work have not been completed.
