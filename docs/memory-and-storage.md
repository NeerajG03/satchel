# Memory, storage, and sharing

Updated 10 September 2026. Explicit saves, no curator, and named memory with progressive disclosure are agreed direction. The current companion/database implementation is identified below; broader sharing and agent behavior remain to be implemented.

## What memory is for

Keep durable, deliberately stated preferences and confirmed decisions useful in later conversations. Distinguish them from project documents, live task status, and historical evidence. A statement that a task was blocked yesterday is evidence; current issue state remains authoritative for whether it is blocked today.

Three semantic scopes were retained in the discussion: the user, a repository, and a project. There is no persona or orchestrator memory scope. Scope describes relevance. It does not grant permission. A work-related user preference can remain restricted to work connections even though its semantic scope is “user.”

## Proposed logical record

The user-facing content has three fields:

| Field | Purpose | Current limit |
|---|---|---|
| Name | A recognizable handle an agent can use to request the memory | Required, 100 characters |
| Description | Explain what the memory covers and when its details are useful | Required, 280 characters |
| More info | Full context, decisions, examples and references, fetched when needed | Optional, 40,000 characters |

Names are unique within the owner's project, compared without case or surrounding spaces. Two different projects may use the same name. Names are editable; stable IDs preserve identity across corrections. A lookup must include the explicit scope, rather than guess between identical names or search across unauthorized projects. A stale name returns unavailable and requires refreshing the index; it never silently resolves to a different record.

The implementation stores these fields, stable ID, owner, project, revision and timestamps. Existing body-only records receive `memory-<original UUID>` as their editable name and an excerpt as their description. The complete stored body becomes More info unchanged. This format conversion advances the revision once. It does not infer a new decision or rewrite the saved text.

The broader record model still needs kind, semantic scope beyond projects, access partition, provenance, source reference or authorized excerpt, writer/client, and current/superseded/deleted state. A correction needs a relationship to its prior version; the current foundation increments revision but does not retain past bodies. Personal and repository scopes remain product requirements, not yet implemented by this change.

An inaccessible conversation URL alone is weak portable evidence. Where appropriate, save a short authorized excerpt or a durable decision note alongside the reference. Do not copy a full transcript merely to provide provenance.

Historical imported material keeps its actual provenance. An agent-authored finding is not relabeled “user-stated.” A `review-required` label in an old schema does not introduce a V1 proposal workflow; unresolved historical items can remain outside active retrieval.

## Write and retrieval behavior

### Explicit save

1. Resolve the intended statement and scope from an explicit request or confirmed decision.
2. Authenticate the writing connection and enforce its permitted partition and operation.
3. Submit an idempotent write to the authoritative store.
4. Return the saved ID and revision only after acknowledgement.
5. Make that revision eligible for fresh retrieval without a curation batch.

Do not ask twice for authorization already supplied by “remember this.” Ask only when the content, destination, or ambiguity requires it. If the write fails, retain the draft and state that it has not been shared. Offline drafts are local, pending data until acknowledged.

### Retrieve

Use a memory index followed by on-demand detail retrieval, like the user's intended skill-loading experience:

1. A supported startup/resume/context-rebuild hook must load **every name and description in the authorized active scope**, together with scope, IDs and current revisions. More info is excluded. This is deterministic discovery, not a relevance-ranked search that may hide memories.
2. The index tells the agent how to request details by name and scope. For example, an index entry `interview-preparation — Practice priorities and feedback rules for interviews` lets the agent request that memory before drafting a practice plan.
3. A separate read returns the current full record, including More info and revision. Authorization is checked again on that read. Agents should read the details before relying on a memory's full instructions or evidence.
4. Re-fetch the index after a known save, correction, rename or deletion, and on each supported context rebuild. Previously injected text cannot be removed from an existing chat; subsequent retrieval must reflect the latest state.

The companion already exercises this separation: `list_memories(p_project_id)` returns only `id`, `project_id`, `name`, `description`, `revision` and `updated_at`; `read_memory(p_project_id, p_name)` returns the full record. Opening a book does not fetch More info. “Read more info” and “Correct” fetch the current record by its scoped name.

The eventual MCP tools should expose the same two operations through connection-grant checks. These database functions currently authorize companion sessions only; agent tokens remain denied. There is no live hook or agent transport yet. Personal and project/repository index composition must be implemented with those scopes; “always loaded” does not authorize loading all of a person's private projects into every chat.

Hook delivery is a requirement for supported, configured hosts, not a promise that every vendor chat can be intercepted. Index size limits, caching and installed-host lifecycle behavior must be verified during integration. If the complete index cannot fit or be fetched, report incomplete/unavailable context explicitly and provide an index-retrieval fallback; do not silently omit entries or claim full context loaded. Never compensate by injecting all More info. There are no automatic transcript uploads or writes through these hooks.

Required rules should remain available as explicit instructions or source guidance rather than depend entirely on search ranking. Retrieved external text is data, not authority to change permissions or override the user's instructions.

Installed workflow instructions can encourage retrieval at the start of project work. They cannot guarantee a model will call a tool in every new chat. Measure ordinary retrieval separately from an explicit “search Satchel” test.

### Correct

Identify the record and expected revision. Write a replacement and supersede the previous version as one consistent operation. Exclude superseded versions from ordinary current-context retrieval; retain history when asked for it. Handle conflicting concurrent edits explicitly instead of silently choosing whichever arrived last.

### Forget

Remove the record from active retrieval and invalidate affected caches/index entries. Explain whether the underlying record, revision history, backups, and exports remain. Satchel cannot erase earlier text from an external chat or a vendor's native memory through a local delete button.

Git-backed deletion would normally retain old content in commit history. A service-backed design needs a documented deletion and backup policy. The product must describe the selected implementation accurately; “forget” is not automatically “erase every copy.”

## Hosting and data storage are different decisions

The latest direction is a hosted Satchel service with native ecosystem integrations. Hosting establishes an independently reachable service; it does not choose the canonical storage for every kind of data.

The earlier Codex report proposed a hosted memory provider pilot, naming Mem0, with Git as fallback. The later Claude handoff recorded a GitHub-backed memory/skills/task choice. The user subsequently clarified that the revamp was primarily visual and that project, skill, and installation mechanisms remained insufficiently thought through. Therefore neither historical storage shape is silently treated as the final Satchel architecture.

| Data | Current position |
|---|---|
| Satchel-managed V1 task state | GitHub Issues is agreed |
| Satchel product code and design documents | This private development repository |
| Skill content | Versioned source packages/repositories, reused where appropriate; final private distribution path open |
| Memory records | Supabase PostgreSQL for the implemented pilot; summary and details share one canonical row |
| Project catalog and briefs | Supabase PostgreSQL for the implemented pilot |
| Code, receipts, statements, original documents | Remain in their appropriate authoritative source unless deliberately moved |
| Search indexes and caches | Derived, permission-aware, rebuildable; never a second independently editable authority |
| Credentials | Supported secure credential storage, separate from content and exports |

The repository containing Satchel's software is not the default repository for all users' memories. A hosted service must separate tenants and access boundaries from the start even if the first pilot has only one user.

## Proposed sharing boundary

Grant each app connection specific operations and access to selected material. Keep personal, work, and restricted people-data boundaries enforceable at the service and backing-source level. Folder names and project labels alone do not provide isolation.

The user's companion session can have different permissions from an agent connection. A context preview must use the selected agent's effective access. A manual export uses the user's access and requires an intentional choice of what to share. Label these as separate actions.

Do not mirror vendor-native memories or suppress them globally. Satchel supplies explicit shared context through supported interfaces. Native memories and previous chats can coexist, and fresh retrieval gives the agent a way to discover current decisions.

## Export and recovery

Export selected authorized records with stable IDs, provenance, scope, revisions, and correction links, plus non-secret project and configuration references. Verify that an export can be read without Satchel. Record which source references still need separate authentication.

An export is a snapshot, not a second writable master. Restoration needs revision reconciliation and access review. Do not overwrite newer records with an old snapshot. Exact export format, retention, encryption, hosting region, and backup policy remain implementation decisions.
