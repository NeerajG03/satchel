# Tasks and handoffs

8 September 2026. GitHub Issues only in V1 is agreed. The workflows and record shapes below are proposed; no tasks have been migrated.

## One task authority

All tasks managed by Satchel V1 use GitHub Issues. Satchel can expose convenient task operations and project associations, but must not create a second independently editable task-status database.

Existing work in Notion or another team tracker remains there. A URL can be retained as a source reference without implying V1 reads, synchronizes, or writes that source. Do not create a shadow GitHub issue for every external ticket merely to populate Satchel.

A project selects a GitHub task destination. It can span multiple code repositories and does not need a dedicated repository solely to exist. The user chooses where an issue belongs if routing cannot be resolved from project configuration.

## Proposed V1 task operations

Support the operations needed for real cross-device work: list/find, read, create, update, close/reopen, record a handoff, and inspect linked work. The earlier discussion also identified dependency edits, priorities, and typed gig attributes as migration needs. Their GitHub representation must be specified and verified; unsupported fields must be reported rather than silently discarded.

Use stable task references tied to the provider identity and source URL. Task projections and cached indexes may aid lookup, but source revision and freshness remain visible.

## Preserve a small backend boundary

Companion and agent-facing operations should call a TaskService that delegates GitHub transport and authentication to a GitHub backend. Public task responses should not simply expose raw GitHub HTTP payloads.

Implement the operations the first release needs. A fake backend can exercise the interface. There is no need to implement a second real provider, dynamic plugin loader, sync cursor service, field-mapping UI, or public SDK just to keep the code extensible.

Later source plugins may import or synchronize external data through this boundary. Their ownership rules, deduplication, credentials, retries, conflicts, and removal behavior are deferred. The historical [source-plugin sketch](archive/jeff-rethinking/JEFF-v2-task-source-plugins.md) preserves those ideas without making them V1 requirements.

## A handoff is portable work evidence

Proposed home: an identifiable comment on the authoritative GitHub issue, with a stable reference and revision/time. Avoid maintaining a separately editable handoff elsewhere. A suggested template is:

```text
Task and project:
Completed:
Decisions and sources:
Validation actually run and results:
Remaining work:
Blockers and dependencies:
Code state: repository, branch, commit, PR, or recoverable patch
Artifacts and source links:
Suggested next action:
Originating app/session/device:
Recorded at:
```

Do not claim validation that was not performed. State which repository each code reference belongs to. Handoffs can be written by agents as work evidence without converting their conclusions into user-stated memory.

## Resume flow

1. Select or resolve a project and task.
2. Read the latest authoritative task and handoff under the caller's permissions.
3. Check that referenced code and artifacts are actually accessible.
4. Identify a supported destination app and execution environment.
5. Launch with context only where that route is verified; otherwise present a bounded copyable handoff.
6. Record task pickup separately from successful app launch or completed work.

A device preference for the default app was discussed, but the exact mapping is open. A hardcoded choice of Codex on desktop and Claude on phone is sample behavior, not a product rule.

An assignee or “in progress” label is a coordination convention, not a lock. V1 does not promise exclusive cross-agent claims. If unattended concurrent workers become a requirement, specify atomic claims separately rather than imply the mockup's takeover button solves races.

## Completion across repositories

One task can require several PRs. Use a non-closing reference such as “Part of owner/repo#123” for partial contributions, and close the overall task explicitly after all required work is verified. Keep task completion, PR merge, deployment, and workspace cleanup separate events.

A handoff cannot transfer uncommitted files automatically. Before changing environments, publish an authorized branch/commit or deliberately transfer a recoverable patch. If code remains only on an unavailable machine, report that blocker.

## Migration fidelity

For migrated active gig tasks, preserve original IDs, title/body, status, priority, relationships, useful events, checkpoints, PR links, and meaningful timestamps. Map agent persona assignees deliberately rather than pretending they are GitHub users.

The historical report records typed gig attributes as strings, booleans, and objects. A versioned marked YAML block is one proposed representation; labels alone cannot preserve these values. Preserve unrelated issue content on edits. Keep closed history searchable without recreating every closed item as new work.

Gig remains the authority for the existing JEFF installation until an explicit, verified cutover. Creating Satchel's repository and collecting docs does not perform that cutover.
