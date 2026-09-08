# JEFF: decisions so far

Written 6 September 2026 from the conversation between Neeraj, Claude, and Codex. Plain statements of what was decided, why, and what is still open. Where the two reports disagreed, the resolution is noted.

## 1. What JEFF is now

**JEFF is a personal library that you and your AI apps share.** Your words, your projects, your skills, kept in a GitHub repo you own, readable and writable from any device and any agent.

- **Library, not brain.** Nothing is remembered on its own. Only what you explicitly said gets written down, with a date, a source, and a place. No inference, no automatic extraction.
- **Shared between you and your agents,** across devices. Not shared with other people in this version.
- **Workspace only lightly.** Work happens in Claude Code, Codex, or wherever. JEFF is where work is picked up and put down. The "Left off" shelf is the only workspace part.
- **The vendors run the agents.** Worktrees, sessions, hooks, subagents, scheduling, PR creation: Claude Code and Codex do these natively now. JEFF stops competing on plumbing.

## 2. Why the rethink

The old JEFF was a Go CLI on one Mac that ran agents: pickup, worktrees, tmux crews, hooks, personas, a memory curator. Most of that is now table stakes in the vendor apps, and a large share of the open task list was JEFF fixing JEFF. The parts nobody else will build are the ones that outlive any vendor: one portable store of tasks, memory, and skills that any agent can reach, and the handoff between devices.

The test applied to every piece: **open Claude on your phone, or a fresh laptop, or a cloud session. Does this piece still exist and still help?** If it only existed because a binary on one volume created it, it moved or went.

## 3. Where every old piece goes

| Piece | Decision |
|---|---|
| Tasks (gig, SQLite) | GitHub Issues. Personal and agent work in the project repos. Team tickets keep Notion as status owner; a JEFF issue only points at a CB ticket, never mirrors its status. |
| Repo registry | A small catalog file. Branch and setup scripts move into each code repo. |
| Worktrees, task workspaces | Dropped. Vendor apps do this per session. |
| Pickup, work, done | Replaced by "Resume here": open the right app on this device with the handover, mark the issue. |
| Checkpoints | Kept as handovers on the issue: completed, decisions, validation run, remaining, code state, session. The only portable resume state. |
| Ship | Dropped. Each session opens its own PR. PRs say `Part of <repo>#N`, never `Closes`, because the first merge would close a multi-repo task. Closure is explicit. |
| Hooks | Retired. Context delivery is a tool call the agent is instructed to make, verified per client. Checkpoint nudge becomes a native Claude Code hook. |
| Skills | Kept as content. Distributed with `npx skills add <owner>/<repo>` from the hub repo. Registry, inject/eject, lock file dropped. Real porting work remains: per-skill dependencies, the hardcoded JEFF volume path in the langfuse env loader, per-machine `.env`. A skill is ported when it runs from a fresh clone on a second machine. |
| Personas | **Dropped entirely.** Role text worth keeping becomes a skill. Persona memory re-scoped by meaning: review preferences become yours, repo facts become repo scope, curator notes archived. |
| Memory | Kept in shape, changed in behavior. See section 4. |
| Curator (marlowe) | **Not built at start.** See section 4. |
| Projects | Each project is its own private repo. See section 5. |
| Crew, orchestrator, dashboard | Dropped. Vendor multi-session plus Issues as the shared board. |
| Providers flag, opencode model map | Dropped. Cross-provider is a property of the protocols chosen, not code. |
| Config, doctor, stats, cleanup, notify, open | Dropped. |
| Python `api` CLI and `lyric-cli` in the JEFF root | Not dropped with the Go launcher. Package independently or fold into the workflows that use them. |
| Jeff-Anywhere epic (hub + worker fleet) | Shelved. It solves remote execution, which is not needed to read shared context from a phone. Its six closed prerequisite fixes are assessed individually. |
| Transcript queue (344 sessions), proposals (99) | Proposals get one sitting of manual triage. Queue is archived outside retrieval, not blanket-deleted; the curator's own finding shows raw counts are slug re-emission noise, but that does not prove every session is worthless. |
| Loose folders (learnings, research, exports, transcripts) | Learnings read once then folded into memory or deleted. Research and exports to a notes repo or Notion. Transcripts stay local and stop being collected. |

## 4. Memory: the book

- **Storage:** `memory/` in the hub repo, one markdown file per line, frontmatter carries scope, source, date, provenance, supersedes. Every save is a commit. Lines show their short commit hash.
- **Three scopes only:** you, a repo, a project. No persona scope, no orchestrator scope. Scope describes relevance, not permission.
- **Explicit saves only.** "Remember this," a clearly stated preference, or a decision you confirm. Agents never save their own guesses. Agents may still write task checkpoints; that is work evidence, not a personal fact.
- **Write directly.** No proposals folder, no queue, no batch. Acknowledged with an id and revision. A failed write keeps the draft and says so.
- **Correct directly.** The session that hears the correction writes the new line, marks the old one superseded, one commit. Old line stays visible as red-ink strike-through. History shows the commits.
- **Forget** deletes the file and commits. Commit history, backups, and earlier chats keep copies. The interface says which of those is true.
- **Native memory is not suppressed.** JEFF used to turn off Claude Code and Gemini memory. It no longer does. Sessions are told to check the shared book first; that is a prompt, not a lock.
- **Provenance is the safety rail** that replaces the curator: `user-stated` for explicit saves, `review-required` for anything derived. Both reports missed that the existing schema already had this field.
- **The accepted cost:** you sometimes have to ask it to remember. Measure missed saves, repeated explanations, and unwanted records over thirty days before reconsidering a curator or extraction.
- **Open:** project-scoped lines currently live in the hub under `memory/<project>/`, not in the project repo. Keeps one place every app reads. Could flip.

## 5. Projects and tasks

- **The hub repo** (one, you own it, you grant access): `memory/`, `skills/`, `projects.yaml` listing each project and its repo. Access is contents plus issues, read and write, nothing else.
- **Each project is its own private repo:** `brief.md`, documents, code if any, and its Issues for tasks and handovers. Interview and intern material stays in restricted repos and out of general indexing.
- **Handovers are issue comments** referenced like `reimbursements#4`. "Resume here" opens the default app on this device with the handover, sets assignee and in-progress, comments which device took it. Other devices see "Picked up on your MacBook" and can take it over. If the app cannot be launched with context, it falls back to a copyable handoff block.
- **Team work stays in Notion.** A CB ticket's status and dependencies live there. Checkpoints go on the ticket or one linked document. No shadow issue per Notion ticket.
- **Typed gig attributes** (string, boolean, JSON) become a marked YAML block in the issue body, not labels.
- **Claims:** assignee plus in-progress is the convention. Not an atomic lock. If unattended agents ever compete, that is the one reason to add a small claim service.

## 6. Storage and hosting

- **Hosted memory service vs git repo:** the report proposed a hosted-service pilot (Mem0 named as first candidate) with git as fallback. **Neeraj then decided: memory, skills, and tasks are all backed by a GitHub repo the user grants access to.** The prototype reflects that. The hosted-service pilot is superseded unless git proves unworkable for phone writes.
- **Permission boundaries:** work and personal material must not sit behind one token. Split by who may read: work context, personal context, and restricted people-data repos. Folder names are not access control.
- **The phone path** needs an issue-capable GitHub connector on claude.ai. The file-sync GitHub integration is not enough. Verify on the actual account before assuming.
- **A home Mac behind a tunnel is not laptop-independent hosting.** Claude connects from Anthropic's cloud; the endpoint must be reachable with the laptop off.
- **The linchpin instruction** ("check the shared book at the start of project work") lives in a per-machine user instructions file. It needs to travel with dotfiles or an install step, or a fresh laptop silently does nothing.

## 7. Migration order and gates (from the revised report)

Phase 0 preserve and classify, nothing deleted. Phase 1 prove the phone loop with synthetic records and push skills to the private repo without removing the registry. Phase 1B fallback decision. Phase 2 port content, bounded memory triage, make scripts run from a fresh clone. Phase 3 cut over tasks per project with an old-id map. Phase 4 retire the Go CLI, crew, and hooks last. Phase 5 evaluate after thirty days. Every deletion has an evidence gate. Never restore an old snapshot over newer changes.

Acceptance targets: an acknowledged save or correction on one device is retrievable on the other within sixty seconds; at least nine in ten ordinary project requests retrieve context without a reminder; after thirty days at least ninety percent of active lines are useful, supported, current, and correctly scoped. These are initial planning numbers.

## 8. The design

**Direction:** a well-made notebook with hardware on it. Paper for what you wrote down. Hardware (switches, LEDs, keys, ribbons, index tabs) for what the apps may do. Chosen by Neeraj from four options: commonplace book plus instrument on a desk. Influences named: Claude's warmth, Arc's confidence, physical objects that do not get in the way.

**What was wrong with the first mockup:** the default admin panel. Sidebar of cards, cobalt button, grotesk headings, a hero that was a diagram of the product, marketing copy inside the product, memory and handoff buried. Nothing on screen could only be JEFF.

**Palette:** paper `#F4F0E7`, ink `#1F1B17`, hardware `#26231F`, one orange `#E4571E` spent only on hardware controls, red ink `#B4271B` reserved for corrections, LED green `#3E9E62` and amber `#E2A11E`. Links on paper are ink with a faint underline, not a second orange.

**Type:** not decided. Three pairings are switchable live from a chip above the prototype:
- Serif book: Newsreader for your words, Instrument Sans for the interface, DM Mono for readouts.
- Grotesk: Schibsted Grotesk for both, JetBrains Mono for readouts.
- Typewriter: Courier Prime for your words, Instrument Sans, DM Mono.
Instrument Serif was dropped after Neeraj said the font was not good.

**Voice:** plain sentences addressed to you. Never "I". "Said on your phone · 09:18", not "Saved by user". No slogans inside the product.

**First screen:** not decided. A chip switches the laptop between "Where you left off" and "The book". Claude recommended Left off because the phone-to-laptop loop is the point.

**Layout:** one interactive artboard, laptop and phone side by side sharing one state, so a save on one visibly lands on the other. Laptop: index tabs on the spine (Left off, Book, Projects, Apps, Skills, Settings) plus a Preview action in the rail. Phone: Left off, Book, Apps, More; More holds Projects, Skills, Preview, Settings. No fake status bar.

**Every screen and flow in the prototype:** save with scope picker; search and filters; correct, history, forget; projects with add and per-project repo; apps with read/save switches and a four-step connection check; skills with class, state, setup steps, and check installation; settings with connect/disconnect repo, what-goes-where tree, a prototype "GitHub unreachable" switch, and export; preview per app and project with blocked and unavailable states and a prepare-handoff block; resume sheets on both devices with takeover and put-back; failed saves keep the draft.

**Dead-end audit:** every clickable element either does its job or leads to the place that does. The audit table is in the conversation and the fixes are in `Main.dc.html`.

**Verification:** every flow was driven headless in Chrome via Playwright before each publish. The in-app browser pane cannot click into the canvas's sandboxed frames.

## 9. Open questions

1. **Font.** Pick one of the three pairings, or name another.
2. **First screen.** Left off or Book.
3. **Name of the first shelf.** "Left off" is a workspace word. In the library framing it is closer to "Bookmarks" or "Open books".
4. **Project-scoped memory location.** Hub `memory/<project>/` (current) or the project repo.
5. **Default app per device** for Resume. One per device, set once under Apps.
6. **Phone write path in practice.** Which GitHub connector on claude.ai supports issues and commits, on Neeraj's account.
7. **Hosted service at all?** The GitHub-only decision makes the Mem0 pilot moot unless phone writes to git prove too slow.
8. **The `api` CLI and `lyric-cli`:** keep, package, or retire, decided on their own merits.
9. **Claim race.** Accept assignee-as-convention or add a tiny claim service later.

## 10. Where the reports stand

- `reports/JEFF-portable-context-report.md` is the plan: revised by Codex to include no personas, no curator, explicit direct memory, hosted-first pilot with git fallback, task and skill portability details, evidence gates, and acceptance tests. Superseded on one point by the later GitHub-only decision (section 6).
- `reports/jeff-porting-map.html` is Claude's earlier shape. Its verdict on personas (keep) and its curator routine are superseded. Its multi-repo `Closes` convention was a bug. Its comparison with Jeff-Anywhere and the "test whether memory improves ten real tasks" idea carried into the plan.
- Both reports were reviewed against each other; the two reviews' corrections are folded into this file.
