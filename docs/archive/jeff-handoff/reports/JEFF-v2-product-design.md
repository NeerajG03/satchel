# JEFF v2: the companion for your AI setup

Product concept and delivery brief · 6 September 2026

**V1 scope clarification:** GitHub Issues is the only task backend. No plugin system or third-party task synchronization ships in V1. Keep task operations behind an internal backend interface so a future plugin system can integrate without changing the companion or agent-facing task contract.

**JEFF is a companion application for configuring the shared memory, project sources, and skills your AI apps use.** Your conversations and execution remain in those apps. JEFF gives you a place to understand, configure, and troubleshoot the setup that makes them useful across devices.

This design follows the user's clarification that the product is a companion for server and agent configuration. It refines the presentation of the [portable-context report](/Volumes/Casesensitive/jeff/exports/jeff-rethinking/JEFF-portable-context-report.md); it does not rewrite that report or initiate its migration.

The V1 task decision supersedes the earlier proposal for JEFF to directly support Notion. Existing external work is not migrated by this design change. See the [V1 backend boundary and deferred plugin design](/Volumes/Casesensitive/jeff/exports/jeff-rethinking/JEFF-v2-task-source-plugins.md).

## 1. What the product is for

The central question JEFF answers is: **“What can this agent know, remember, and use—and is that actually working?”**

The first experience should help you connect an existing memory service, configure supported AI clients, select project sources, and prove one explicit save and fresh retrieval across devices. Returning visits should be brief: correct a preference, add a project source, troubleshoot a failed connection, or check a skill installation.

You should not have to open JEFF before every chat. Supported clients retrieve shared context directly after configuration. JEFF is where you manage that arrangement and intervene when necessary.

Server ownership is optional. An existing hosted memory service is the first pilot. Connecting a self-hosted endpoint is an alternative. JEFF should configure supported services without becoming a general server administration console.

### Product boundaries

| JEFF owns | Existing systems keep owning |
|---|---|
| Project/source catalog and relevant access configuration | Code and original project documents |
| Visibility into current shared memory and direct corrections | The selected memory backend's canonical records |
| Connection setup guidance, supported configuration, and checks | Client authentication, tool execution, and native conversation state |
| Skill sources, target compatibility, and setup guidance | Existing skill distribution and per-machine execution |
| Context preview and a clearly labeled handoff fallback | Live JEFF task status in GitHub Issues |

No new chat interface, persona roster, curator, proposal inbox, task-status database, model router, worker fleet, plugin runtime, or dashboard of agent activity is part of this version.

The screen space must earn its maintenance cost. If configuration is rarely changed and existing service interfaces already expose everything needed, JEFF can remain a very small companion. Building a broad workspace merely because the data exists would undo the simplification.

## 2. The visual direction

**Latest design study:** the user liked the layout but asked for a more distinctive, fully considered visual system. The [refined visual direction](/Volumes/Casesensitive/jeff/exports/jeff-rethinking/JEFF-v1-visual-direction.md) proposes neutral surfaces, a cobalt accent, a visible context path, and explicit Light/Dark/System controls. The earlier forest treatment described below is retained as the initial concept, not the sole proposed direction.

The interface uses a forest accent, warm neutral surfaces, quiet borders, Manrope headings, and DM Sans body text. The priority is legibility and confidence in source ownership. Status labels explain meaningful conditions such as read-only access; they do not invent an “agent intelligence score.”

Web uses a narrow sidebar and generous main workspace. Android uses a compact header, four bottom destinations, touch-sized actions, and a single content column. Access and correction flows use full screens, so important information is not compressed into tiny dialogs.

The mockups include optional design controls for a forest or ink accent, comfortable or compact density, and corner radius. These explore presentation without changing the product model.

### Navigation

| Destination | Purpose | Primary action |
|---|---|---|
| Overview | Understand the setup and any actionable gaps | Preview context or check connections |
| Connections | Manage each supported client's access | Configure read/write and allowed projects |
| Memory | Inspect explicit records and their provenance | Save, correct, view history, or forget |
| Projects | Register project briefs and authoritative sources | Add a project and grant access |
| Skills | Understand a workflow's source and execution requirements | Inspect instructions and setup steps |
| Configuration | Choose the memory backend and inspect ownership | Configure an endpoint or export records |

Android's bottom navigation is Home, Memory, Connect, and More. More contains Projects, Skills, Configuration, and context preview. This avoids six crowded tabs without deleting those capabilities from the phone design.

## 3. The complete screen set

### Overview

Show the connected clients, the memory source, and a small actionable setup gap. The example starts with Claude Android able to read but unable to save. “Review Claude access” takes you directly to the relevant controls. Context preview is the primary action; a connection check is secondary.

There is no task board here. A recent memory provides a useful sample of what is being shared, and can open its source/history. On small screens that secondary item yields space to the connection setup.

### Connections and client configuration

Each client has a recognizable name, a device/surface, and an explicit state: unconfigured, read only, read and save, disconnected, or a failed check. Never infer mobile capabilities from desktop support.

Client detail separates read permission, write permission, and allowed project sources. It also explains the retrieval instruction needed when starting project work. Access to a repository or an endpoint alone is insufficient proof that an agent uses it.

In production, these switches must reflect enforced backend permissions and the client's supported setup route. Where the client requires a manual installation or account-side configuration, JEFF should show “Setup required” and guide the user; it must not present a locally toggled switch as a verified integration.

Disconnect should stop future shared-source access through the applicable credentials/permissions. It cannot erase text that a provider already received in an earlier conversation. The live implementation must reflect the credential ownership of the chosen connector.

### Memory list, save, detail, correction, and deletion

Memory shows explicit statements and current decisions, with scope and source. Search and scope filtering narrow the collection. There are three semantic scopes: you, a repository, and a project. Work/personal access boundaries remain separate from these scopes.

Saving is direct. The record includes the statement, source, scope, writer, time, and revision. An acknowledged write is immediately eligible for retrieval. A failed write retains the draft and reports failure. No background review or curation follows it.

Correction starts from a specific record. The new revision becomes current; the prior text remains accessible as superseded history. Current context previews exclude previous versions. Provenance should distinguish an explicit user statement from historical or derived evidence; the mockup's sample records are explicitly labeled.

Forgetting removes the record from active retrieval. The confirmation explains retained history/backups and earlier conversations. The real product must invalidate relevant caches/indexes and report the selected backend's actual deletion behavior.

Android adds a useful eventual entry point: an explicit “Share to JEFF” capture screen for selected text or a source link. The user chooses the scope and saves. Sharing must not silently capture the whole conversation or make an inferred preference permanent. This is a proposed native feature; the browser prototype demonstrates its destination save flow, not an Android share intent.

### Projects and authoritative sources

A project combines a brief, source reference, relevant repository links, task authority, and access configuration. It has a stable identity across clients. Its card links to context, not a second project-management system.

The example includes a personal JEFF pilot, a work release workflow, and personal reimbursements. These are illustrative records. Production migration still requires classification of the actual documents.

All tasks managed through JEFF V1 use GitHub Issues. Notion and other third-party task sources are not supported in V1. Existing team work in other tools stays there until a later, explicit integration or migration; JEFF must not imply it can read or synchronize those records. Source links open the GitHub task. Restricted interview material, statements, and receipts are outside general memory indexing by default.

### Skills library, details, and installation guidance

Each skill shows its purpose, version/source, capability class, and compatible execution environment. Instructions, connected workflows, local scripts, and local application control have different requirements.

Skill distribution initially uses the private repository and existing `npx skills` tooling. JEFF should record the intended target and last verified installed revision where it can establish those facts. Without a verified installation signal, use “Setup required” or “Not verified,” not “Installed.”

Android can inspect a skill and prepare the work. It cannot run a laptop script just because it can read its instructions. Remote execution or a desktop helper is outside the initial product scope unless an actual requirement justifies it.

### Configuration and portable export

Show one active memory authority: an existing hosted service or a user-supplied remote endpoint. Production credentials belong in supported secure storage and sign-in flows, not arbitrary browser persistence or memory exports.

Changing backends is a migration: export, verify record counts and provenance, check corrections/deletions, then cut over authority. It is not a harmless dropdown change. The mockup changes local example configuration only and labels it accordingly.

Exports contain portable records, scopes, source links, history, and non-secret configuration. They are backups until deliberately restored; they do not become a second writable memory authority.

### Context preview and handoff

Choose an app and project. Show the current brief, relevant records, their provenance/revisions, source references, and available skills. Exclude unauthorized material and superseded records. An unavailable service produces an unavailable state instead of a reassuring preview based on old data.

A real preview must use the selected client's effective authorization. The user's broad administrative account must not supply a deceptively generous preview of what a narrower agent credential can read. If effective-client preview is unsupported, label the limitation.

The example includes “Prepare handoff,” a manual copy fallback. It does not launch a model, install tools, or transfer unsaved code. The live default remains direct tool retrieval where supported.

### Connection check and recovery states

The demonstration checks endpoint availability, phone write permission, desktop read access, and revision visibility. It initially exposes the phone's missing write permission. After changing that permission, the simulation can pass. An optional prototype-only condition in Configuration simulates an unavailable memory service.

Actual verification requires two levels: an integration check that can read/write through the relevant identities, and a real fresh-chat check on the supported apps. A server-side probe cannot prove that a model called retrieval at the right time. Show those results separately, with time and scope.

The phone-to-laptop target from the report remains an acknowledged save/correction visible within sixty seconds. No latency or integration success is established by this mockup.

## 4. What the web and Android deliverables would be

| Deliverable | Initial scope | Explicit limit |
|---|---|---|
| Responsive web companion | All six destinations, supported setup, source management, memory operations, context preview, checks | No new chat/task execution runtime |
| Android companion | Same account/configuration, memory and connection flows, project/skill inspection, explicit share-to-save entry point | No automatic interception of other apps' conversations or laptop execution |
| Integration layer, where necessary | Compose the chosen memory service, GitHub task backend, and supported client configuration; preserve auth, revisions, and receipts | No plugin loader, third-party task adapter, or sync engine in V1 |
| Internal task boundary | Define task operations independently of GitHub transport; implement them with GitHub only | An extension seam, not a public plugin SDK or runtime |
| Portable configuration and export format | Project IDs, source references, scope/access mappings, non-secret settings, exportable memory metadata | Not a second canonical database |
| Installation and recovery documentation | Per-client setup, supported/unsupported matrix, backup/restore and troubleshooting | Do not describe untested clients as supported |

**Recommended first executable delivery:** one responsive web companion that works well on Android browsers, plus verified backend/client integrations. Establish the useful behavior before maintaining two application builds. The Android visual design is included now; a native installable build is a separate delivery milestone, justified by share-to-save and mobile conveniences that matter in daily use.

An installable web experience can be an intermediate packaging option. It should not be labeled a native Android APK. The final packaging choice follows the required device capabilities and implementation testing.

## 5. Delivery sequence

1. **Interactive design prototype — this deliverable.** Explore every main destination and the important save, correction, access, failure, and preview flows using sample data. No real server or client configuration changes.
2. **Prove the integration.** Select one memory backend and one actual phone/laptop pair. Verify explicit record writes, correction semantics, isolation, current retrieval, export, and laptop-off access before adding production polish.
3. **Ship the minimal web companion.** Implement the screens around verified capabilities. Use genuine authentication, acknowledged writes, conflict handling, and per-client access checks. Clearly distinguish configured, manually instructed, and verified states.
4. **Deliver Android packaging and capture.** Reuse the established data model and authorization. Add explicit share-to-save, secure device sign-in, and mobile behavior. Test real device lifecycle and offline drafts.
5. **Evaluate daily usefulness.** Track successful ordinary-chat retrieval, stale/incorrect records, missed explicit saves, configuration failures, and time spent maintaining JEFF. Add features only when they address the observed friction.

These are milestone boundaries, not time estimates. Authentication and client compatibility are material unknowns until tested.

Plugin installation, community packages, field mapping, sync scheduling, provider credentials, and two-way synchronization are later work. V1 should neither expose unfinished plugin settings nor depend on a plugin abstraction to operate GitHub tasks. The only future-facing task work is a clean internal service/backend boundary and extensible provenance metadata where needed.

## 6. Acceptance criteria for an actual release

- A new user can configure the chosen supported backend and see whether each client still needs manual setup.
- A record saved explicitly on one supported device is current in the other client's fresh retrieval within the chosen target.
- Correcting a record changes future retrieval without a batch job and keeps recoverable history.
- Effective access rules prevent unrelated work/personal or project records from appearing in the preview or client retrieval.
- Failed and concurrent writes never receive misleading success acknowledgements or silently overwrite unrelated edits.
- Task links resolve to their authority; JEFF never reports mirrored status as definitive.
- Skill installation state identifies its target, source revision, and verification time; a phone-only skill view cannot imply local script capability.
- The core flow remains available while the laptop is off, provided the selected backend is independently reachable.
- Offline drafts remain clearly local until acknowledged remotely. On reconnection, revision checks prevent stale corrections from silently winning.
- Export and recovery preserve provenance and supersession while excluding credentials.
- Web keyboard navigation, readable light/dark themes, narrow layouts, and Android touch navigation work across the core flows.

## 7. What this prototype implements

The web and Android mockups are interactive, isolated previews with independent in-memory sample state. Navigation, client access changes, memory search/filter/save/correct/history/forget, project registration, context filtering, skill setup views, configuration changes, export text, and simulated connection checks respond locally.

The previews contain no real credentials, task links, provider API calls, stored transcripts, or backend writes. Reloading resets their sample state. Changing one preview does not synchronize the other. Clipboard actions copy or select sample text only.

A backend outage can be explored under Configuration → Prototype conditions. Attempting a save while unavailable retains the draft and reports failure. This setting is a design/testing control and should not appear in the production product.

Not delivered here: a deployed web service, native Android package, sign-in, actual connector provisioning, remote configuration, durable/shared storage, server installation, or a completed portability pilot. The purpose of the mockup is to make the product concrete enough to review before committing to that implementation.

Prototype verification covered connection failure and repair, direct correction and current retrieval, superseded history, unauthorized context, failed-save draft preservation, skill setup, phone save/forget, and mobile navigation. The checked layouts had no horizontal overflow at content widths of 1,048, 748, 368, and 320 pixels. Light and dark presentations were visually inspected; the exercised flows produced no JavaScript runtime errors. These checks validate the local interaction design, not any provider integration.

## 8. The central design decision

The product should remain a small companion you trust and occasionally adjust. Its success is that your preferred AI apps use the correct context without repeated setup—not that you spend more of your day inside JEFF.
