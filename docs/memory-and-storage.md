# Memory, storage, and sharing

8 September 2026. Explicit saves and no curator are agreed direction. The record model and storage mechanisms below are proposals for implementing that direction.

## What memory is for

Keep durable, deliberately stated preferences and confirmed decisions useful in later conversations. Distinguish them from project documents, live task status, and historical evidence. A statement that a task was blocked yesterday is evidence; current issue state remains authoritative for whether it is blocked today.

Three semantic scopes were retained in the discussion: the user, a repository, and a project. There is no persona or orchestrator memory scope. Scope describes relevance. It does not grant permission. A work-related user preference can remain restricted to work connections even though its semantic scope is “user.”

## Proposed logical record

Each record needs a stable ID, statement, kind, semantic scope, access partition, provenance, source reference or authorized excerpt, writer/client, recorded time, revision, and current/superseded/deleted state. A correction needs a relationship to its prior version.

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

Resolve the project, enforce the requesting connection's access, and fetch relevant current records. Include source and revision metadata. Resolve project-linked repository context explicitly; looking only for user and project labels can omit important repo constraints.

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
| Memory records | One authority per record; Git-backed versus hosted record storage remains open |
| Project catalog and briefs | Portable logical records; physical store remains open |
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
