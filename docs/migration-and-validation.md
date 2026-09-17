# JEFF migration and Satchel validation

Historical capability mapping and proposed evidence gates · 8 September 2026. This document performs no migration, deletion, retirement, or installation.

## Where the existing responsibilities go

| JEFF responsibility | Intended Satchel treatment |
|---|---|
| Initialization, home directory, configuration | Account/service setup plus supported native plugin installation; machine setup stays with its environment |
| Projects and repository registry | Portable project catalog with repository/source references and separate local mappings |
| gig task state | Supabase-native Satchel tasks after a verified, explicit cutover; preserve IDs, history, links and exports |
| Pickup/work/done | Native execution plus task operations and portable handoffs |
| Worktrees and task folders | Native app/Git ownership; retain focused multi-repo setup scripts where needed |
| Checkpoints | Structured work evidence on the authoritative task |
| Ship, PRs, releases | Native Git and repository workflows; link evidence and close multi-repo work deliberately |
| Skill registry/injection | Versioned skill sources and existing native distribution; separate installations and execution requirements |
| Personas and default persona models | Retire identities; useful procedures become skills, repo guidance, or supported records by meaning |
| Memory capture/proposals | Explicit direct saves; no session-end extraction or proposal queue |
| Curator | No initial curator or scheduled replacement |
| Retrieval/startup context | Small supported integration workflows and authenticated service retrieval, verified in fresh chats |
| Native-memory suppression | Do not reproduce it; eventually remove only old JEFF-generated settings during authorized cutover |
| Crew, orchestrator, tmux and worker messages | Native sessions and coordination; durable work evidence leaves the process boundary |
| Provider/model maps and usage routing | Native app settings and accounts; Satchel records origin where useful |
| Session capture, inbox replay, heartbeats | Retire with duplicate runtime after active work is preserved |
| Dashboard, status and statistics | Native execution views; Satchel shows context/access/setup evidence relevant to continuity |
| Notifications and scheduling | Existing app/CI features; no background curation service |
| Doctor | Cross-client checks with distinct installation, access, freshness, and real-chat results |
| Cleanup, open, IDE selection, shell completions | Native tools and environment configuration; not core Satchel responsibilities |
| Exports, research, learnings and artifacts | Classify and keep in appropriate sources with durable project links; no bulk ingestion |
| Transcript queue | Protected archive outside normal retrieval, with deliberate retention decisions |
| Python `api` CLI and `lyric-cli` | Evaluate/package useful functionality independently of the Go launcher |
| Jeff-Anywhere fleet epic | Shelve as a direction for continuity; assess useful completed prerequisites individually |

## Preserve skill knowledge without importing its old runtime

The earlier report includes an inventory-based disposition of 25 skills. Its detail is retained in [the original capability report](archive/jeff-rethinking/JEFF-portable-context-report.md). Preserve investigation and database workflows (`aws`, `oodle`, `mongodb`, `temporal`, `langfuse`, `prompt-mgmt`, `root-cause`); review/testing procedures; code generators; release procedures; reimbursement scripts; editor and specialist workflows; and useful skill-authoring guidance according to actual use.

Keep their dependencies and audience explicit. Existing Notion or Slack workflows may continue independently; importing their skill documentation would not establish a built-in Satchel task integration. Recheck the historically deprecated `notion` skill before using it. Retire active `curation` and `crew-orchestrator` behavior while preserving historical evidence and any independently useful procedure.

The old inventory is dated evidence, not a fresh audit. This documentation update has not executed those workflows or certified their portability.

## Historical memory and task material

The prior reports recorded 68 accepted entries, 99 proposals, and 344 queued session references, along with seven personas and sixteen configured/built-in hooks. These counts came from the earlier inspection and have not been refreshed here.

Re-scope useful records by meaning and source: a review preference may belong to the user, a backend fact to a repository, and a cross-repo decision to a project. Do not assume everything under a persona name is a user preference. Preserve agent-derived provenance honestly.

Use one bounded triage for old proposals. Archive unresolved items outside active retrieval. Repeated queue slugs justify checking duplicates, not blanket deletion of every session. Migration triage is not an ongoing curator feature.

## Proposed sequence and gates

1. **Preserve and classify.** Record source revisions, active sessions, dirty worktrees, access partitions, historical exports, and dependency inventories. Gate: recoverable backup and clear ownership; no interruption or deletion.
2. **Prove continuity with synthetic data.** Test a real supported phone/laptop pair against the chosen service and host integrations. Gate: save, retrieve, correct, revoke, fail, export, and laptop-off behavior are evidenced.
3. **Resolve storage and installation choices.** Select the smallest architecture that passes the tests. In parallel where practical, prepare a reviewed private skill package without removing the registry. Gate: actual per-host installation and a representative second-machine script run.
4. **Move selected content.** Preserve provenance, IDs, scope, correction links, source access, and useful skill dependencies. Gate: validated records and source mappings, no blanket upload of JEFF home.
5. **Cut over selected tasks.** Verify personal/project scope, state, dependency links, typed attributes, handoffs, and original-ID mapping. Gate: Supabase is the one authority for migrated records, with usable historical lookup.
6. **Retire duplicate runtime last.** Finish or preserve sessions, uncommitted code, hooks, and tool dependencies first. Gate: normal work no longer needs the removed component; useful Python/specialized tools still run.
7. **Evaluate daily use.** Measure repeated explanations, missed saves, stale facts, failed retrievals, setup friction, cost, and maintenance time. Improve the demonstrated problem rather than automatically adding a curator or fleet.

These are proposed gates, not a scheduled implementation plan. An archive is not permission to delete the source. After cutover, never restore an old snapshot over newer writes; pause and reconcile changes before changing authority again.

## Acceptance scenarios

| Scenario | Required evidence |
|---|---|
| Phone → fresh laptop chat | Explicit saved record is retrieved with the correct scope/source/revision |
| Laptop → fresh phone chat | Reverse loop works through the claimed supported route |
| Laptop off | Shared context access and phone writes remain usable |
| Ordinary project request | Relevant retrieval occurs without an extra “search memory” instruction; irrelevant records are excluded |
| Explicit-only behavior | Brainstorming creates no confirmed personal memory; an explicit save does |
| Correction | New current record replaces old context without a batch job |
| Concurrency/retry | Unrelated edits survive, conflicting edits surface, retries do not duplicate writes |
| Project/access isolation | Similar names, work/personal boundaries, and revoked access cannot leak context through search or caches |
| Companion identity | Direct phone saves do not depend on a separate Claude/Codex grant |
| Effective-client preview | Matches what that connection can retrieve; manual export is labeled separately |
| Task operations | Supported surfaces can perform Satchel task operations; hierarchy/dependencies, conflicts and unavailable resources remain visible |
| Multi-repo completion | A partial PR cannot prematurely complete the overall task |
| Code transfer | Recipient can access the referenced code or is told it remains unavailable |
| Skill installation | Correct source/version/scope is established in each tested host |
| Skill execution | Representative script runs from a fresh clone on another machine with declared dependencies |
| Mobile limitations | Instruction visibility never falsely implies local-script execution |
| Failure/offline | Draft remains available; pending writes are never reported as remotely saved |
| Forget | Active retrieval excludes the record and retention limits are accurately described |
| Export/recovery | Provenance, IDs, corrections, and scopes survive; credentials do not enter the export |
| UI | Keyboard and touch flows, readable light/dark themes, narrow layouts, and crowded states work |

Record account, surface, app/plugin version, grants, environment, source revision, time, and observed result for each integration test. Browser sample-state tests are not substitutes.

Earlier proposals used ten representative records across two projects, a sixty-second freshness target after acknowledged writes, nine ordinary successful retrievals in ten opportunities, and a manual thirty-day quality check targeting 90% useful/current/supported/correctly scoped records. These remain unmeasured planning targets. Report missed expected memories separately; an almost-empty accurate store is not success. Access leaks, lost writes, and false provenance are failures even if average retrieval looks good.
