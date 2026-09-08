# JEFF task backend: V1 boundary and future plugins

Scope decision and deferred design sketch · 6 September 2026

**V1 ships GitHub Issues only. The plugin system comes later.** No plugin installation, plugin SDK/runtime, third-party adapters, sync engine, or plugin UI is part of V1. Notion is not provided by JEFF.

## V1: build the seam, not the plugin system

Task operations should flow through a small internal boundary:

```text
Web / Android / agent-facing task API
                  ↓
              TaskService
                  ↓
       TaskBackend interface
                  ↓
        GitHub implementation
```

Implement only the operations V1 actually needs, such as listing, retrieving, creating, updating, and closing/reopening tasks. Domain objects should not expose raw GitHub HTTP responses as the public task contract. Keep GitHub authentication, request handling, pagination, and error translation in its backend implementation.

Use stable task references and optional provenance metadata where required. Do not prebuild a synchronization ledger, field-mapping engine, plugin configuration renderer, generic credential broker, arbitrary-code sandbox, marketplace, or installer. Those are substantial features, not prerequisites for a clean interface.

Tests should verify TaskService against its contract and the GitHub adapter's actual behavior. A fake backend is enough to test the boundary; no real second provider or public SDK is needed to prove extensibility. Document that third-party import adapters may use TaskService later; a future source plugin need not replace the GitHub task backend.

**V1 deliverable:** working GitHub task operations behind the internal boundary, appropriate GitHub configuration, and the companion's task-source views. The current turn updates the design and prototype only; it does not implement that production backend.

## Deferred: design considerations for a later release

Everything below is a future design sketch, not V1 scope, a promised SDK, or a requirement to implement now. When plugin work is explicitly started, validate and simplify the proposed contract against the first real external source.

This is a later extension to the [companion product design](/Volumes/Casesensitive/jeff/exports/jeff-rethinking/JEFF-v2-product-design.md). It supersedes the earlier design assumption that JEFF directly provides Notion task-source support. It does not move existing gig or Notion records.

## 1. The boundary

```text
GitHub Issues ─────────────── built-in JEFF task backend
                                    ▲
                                    │ validated changes
                              task sync host
                                    ▲
                                    │ normalized records
                     optional third-party source plugins
                     Notion / Linear / another service
```

JEFF's task interface is backed by GitHub Issues; it does not introduce a second independently editable task database. A small operational store holds sync cursors, identity mappings, applied revisions, run receipts, and conflict records. That is synchronization metadata, not another authority for task content.

Without plugins, GitHub-backed tasks work normally. Installing a source plugin adds import/sync functionality and configuration for that service. Removing it stops future synchronization while preserving the imported GitHub issues.

Plugins here are JEFF task-source extensions. They are distinct from agent skills, Codex plugins, or Claude plugins. A skill describes how an agent should work; a source plugin reads an external API and translates records into tasks.

## 2. What JEFF and plugin authors provide

| JEFF core | Plugin author |
|---|---|
| GitHub issue access and a stable task interface | Provider authentication declaration and source discovery |
| Versioned task-source contract and validation | Provider API implementation, pagination, and source revisions |
| Install/configure/pause/remove lifecycle | Configuration schema and capability declarations |
| Scoped credentials and execution boundaries | Translation of provider records into normalized tasks |
| Dry-run preview, identity mapping, retry/recovery | Translation of provider statuses and links |
| GitHub writes, managed body sections, conflict reporting | Optional source-writeback implementation if supported later |
| Run receipts, last successful sync, exportable mappings | Provider-specific error messages and compatibility maintenance |

The plugin produces proposed task changes; the host validates and applies them through the built-in GitHub backend. Plugins do not receive a universal GitHub token or direct access to shared memory. Avoid letting every author invent their own issue-writing, deduplication, and retry logic.

Source-task imports remain task data. Installing a plugin must not turn third-party descriptions into permanent user preferences or bypass the explicit-memory policy.

## 3. Installation and configuration

The first version needs package installation from an immutable repository/package reference. A public marketplace, ratings, billing, and an arbitrary plugin UI framework are unnecessary at the start.

The companion flow is:

1. **Add plugin.** Inspect publisher, pinned version/digest, compatibility, source location, and requested permissions. No vendor source is preinstalled except the built-in GitHub backend itself.
2. **Connect source.** Authenticate using the plugin's declared supported flow. Choose a specific account/container, not every record the account can read.
3. **Choose destination.** Select the JEFF project and GitHub repository. Check destination access and intended audience before copying source material there.
4. **Map fields.** Preview title, description, state, optional attributes, and links. State which fields are source-controlled and which remain JEFF-controlled.
5. **Preview.** See creates, updates, unchanged records, excluded records, and conflicts before the first apply.
6. **Enable sync.** Start manually. Scheduling/webhooks can follow through the host when required; plugin workers do not create their own hidden schedules.

The Android app configures and inspects the same host. Sync execution belongs on an independently running server/worker so it does not depend on the phone remaining open or a laptop staying awake.

## 4. Proposed manifest

This is illustrative schema, not the name of a shipped package or an existing supported service:

```json
{
  "id": "example/notion-task-source",
  "name": "Notion task source",
  "publisher": "Example community author",
  "version": "0.1.0",
  "contractVersion": "1",
  "kind": "task-source",
  "entrypoint": "dist/plugin.js",
  "capabilities": {
    "read": true,
    "incrementalRead": true,
    "writeback": false,
    "webhooks": false
  },
  "permissions": {
    "source": ["selected-container:read"],
    "destination": ["selected-repository:issues-write"]
  },
  "configSchema": "config.schema.json",
  "credentialSchema": "credentials.schema.json"
}
```

The package's integrity and provenance must be verified against its installation reference; a publisher string is not evidence of trust. Credentials are supplied through the host's credential boundary and excluded from manifests, exports, records, and logs. Configuration schemas describe the native companion form rather than injecting arbitrary provider HTML.

## 5. Proposed author contract

```ts
interface TaskSourcePlugin {
  validateConfig(config: unknown): ValidatedConfig;
  checkConnection(context: SourceContext): Promise<ConnectionResult>;
  readChanges(context: SourceContext, cursor?: string): Promise<ChangePage>;
}

interface ChangePage {
  records: SourceTaskChange[];
  nextCursor?: string;
  hasMore: boolean;
}

interface SourceTaskChange {
  sourceId: string;
  sourceRevision: string;
  operation: "upsert" | "source-deleted";
  task?: {
    title: string;
    description: string;
    state: "open" | "closed";
    attributes?: Record<string, string | boolean | object>;
    relatedSourceIds?: string[];
  };
  sourceUrl: string;
}
```

`SourceContext` contains only validated configuration, scoped credential access, permitted HTTP access, cancellation, and redacted logging. The exact execution technology is an implementation choice to validate; the contract must not rely on arbitrary trusted in-process code access. Worker timeouts, resource limits, and network/credential boundaries must be enforced by the chosen host.

The host supplies stable identifiers for the plugin installation, connected source account, selected container, and destination repository. The identity of an imported record combines those source identifiers with `sourceId`; titles are never identities. Reinstallation must reconnect to retained mappings deliberately instead of generating duplicate tasks under a new installation ID.

An optional later writeback capability should be a separately versioned contract with expected source revisions and explicit requested fields. V1 does not require or advertise two-way sync.

## 6. Field ownership and task authority

“GitHub is the task backend” does not mean two systems can overwrite every field freely. Each sync profile assigns ownership.

| Field | Initial continuous-sync policy |
|---|---|
| Issue title | Source-managed when selected in the mapping |
| Imported description | Source-managed section of the issue body |
| Open/closed state | Explicit mapped source status when enabled |
| Source ID/link/revision | Host-managed metadata |
| Agent checkpoints and local notes | JEFF/GitHub-owned; preserve across sync |
| Unrelated labels/assignee | Preserve unless an explicit supported mapping owns them |
| Typed custom attributes | Structured metadata with original types; do not flatten all values into labels |

For import-once mode, the plugin initializes records and then stops updating their content. GitHub owns subsequent edits. For continuous one-way sync, the source remains the editor of mapped fields, and GitHub is the JEFF task representation. Label that distinction in the UI.

A user edit to a source-managed field is a conflict when the destination differs from the last applied snapshot. Surface the conflict and allow a deliberate resolution or ownership change. Do not choose whichever timestamp is later. A manual first-run preview alone is insufficient protection for later unattended writes.

GitHub writes should preserve unrelated fields/body sections and recheck the destination just before applying a change. Do not claim atomic compare-and-swap semantics unless the actual API/write path provides them. Where races cannot be eliminated, document the limit, use narrow writes and conflict detection, and avoid unattended overwrite of contested fields. Provider consistency constraints must be tested during the integration pilot.

## 7. Reliability and lifecycle

- **Stable mapping:** persist source identity to GitHub issue ID. Replaying a record or webhook must update the same issue, not create another one.
- **Crash recovery:** handle the interval between issue creation and saving its mapping. Record a deterministic import identity in host-managed issue metadata and reconcile it before retrying uncertain creates. Do not assume GitHub issue creation has a native idempotency key.
- **Checkpointing:** advance a change-feed cursor only after each record on that page has a durable success, no-op, or explicitly tracked unresolved disposition. A crash must not lose unseen changes.
- **Concurrent runs:** serialize overlapping runs for a sync profile, or use equivalent ownership/revision protection. Duplicate delivery is expected.
- **Partial errors:** report per-record outcomes. Retry transient failures with bounds/backoff; show credential or mapping failures that need intervention. One failed item must not be presented as complete success.
- **Deletion:** a source deletion is an explicit tombstone, not inference from a failed/partial scan. Initially retain the GitHub issue and flag the missing source. Closing or deleting destination work requires a separate chosen policy.
- **Dependencies:** resolve related source IDs after identity mapping; retain unresolved relationships for later reconciliation instead of inventing links.
- **Pause:** stop new runs and handle any in-flight apply according to the host's cancellation boundary. Preserve mappings and imported issues.
- **Uninstall:** stop scheduling, revoke plugin access, preserve imported issues and recoverable identity mappings. Previously copied content is not erased from GitHub by revoking source access.
- **Updates:** pin versions; a permission expansion, schema change, or changed mapping requires visible review. Retain a rollback path without rolling back newer task content blindly.
- **Configuration changes:** changing the source account/container or destination repository creates a migration decision; it must not silently re-use incompatible mappings or duplicate the old import.

Copying a restricted source into GitHub changes where the data can be read. The host must verify the destination audience is acceptable before the first sync. Later source access revocation cannot automatically retract content already copied into issue history; make that retention boundary explicit.

## 8. Possible later plugin release

When a plugin release is explicitly scoped, extend the existing GitHub backend with a versioned source-plugin SDK/contract, a loader and isolated execution host, scoped credentials, a configuration form renderer, a synchronization ledger, dry-run/apply operations, and run/error views as actually needed. Provide a synthetic fixture plugin for development and contract tests. None of these plugin facilities is required in V1.

Do **not** bundle a Notion implementation as part of the core delivery. A community or separately maintained package can implement it against the future SDK. Plugin setup screens were explored and then removed from the V1 mockup to match the user's scope correction.

Initial acceptance tests cover replay without duplicates, recovery after an uncertain create, pagination/checkpoint recovery, preservation of GitHub-only fields, conflicting edits, source tombstones, revoked access, pause/uninstall, retained mapping on reinstall, and restrictive destination permissions.

This turn delivers the V1 boundary decision and this deferred sketch. It does not deliver an executable plugin host, a deployed GitHub adapter, downloaded third-party code, or authenticated synchronization. The V1 prototype contains no plugin controls.
