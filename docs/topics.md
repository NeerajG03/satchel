# Topics

Proposed · 7 October 2026. Direction agreed with Neeraj in conversation; the mechanisms below are proposed and not built. This replaces the project model in [projects.md](projects.md) once it ships.

The rule for this design: keep it simple. A small system lasts longer and has room to grow. Anything not needed on day one is under "Later, if needed".

## The short version

Projects become topics, and Satchel can make topics on its own. That is the whole change.

```
topic
├── name, one-line summary
├── memories             many per topic; each memory sits in at most one topic, like a project today
├── repository links     optional, only you or an agent add these
└── tasks                optional
```

A "project" is just a topic that has a repository link or tasks on it.

A memory with no topic is personal, exactly like a memory with no project today. The database keeps it that way, because "no project means personal" is built into about 13 functions and the `personal` grant flag. In the UI and the tools, Personal shows as the first topic, pinned at the top, marked "always loads".

## Why

Today the only way to group memories by subject is to make a project. So anything without a project lands in personal.

On 7 October, 5 of the 14 personal memories were work facts with no project (base images, the monitoring tool, VPN rules). They load into every session, including ones that have nothing to do with them. Personal had turned into a junk drawer.

If Satchel can make a topic when nothing fits, those facts get a home, and personal goes back to being about you.

## First experiment: the pass makes topics (built, 7 October)

The smallest piece that proves the idea: items 2 and 5 below, with no rename and no migration. A topic is stored as a project, because projects can already be made by an agent connection.

- The pass can name a new topic when a work fact fits no listed project. A name that is a near spelling of a listed one reuses it (`nearSlug` in `server/consolidator.mjs`).
- It only does this on a connection that sees every project and may write. Otherwise it behaves exactly as before. `SATCHEL_NEW_TOPICS=off` turns it off.
- Each topic it makes shows in activity as "made topic". A topic that could not be made leaves its memory in personal, as before.

How it was measured. A blind subagent read all 71 real memories and said where each belongs: personal, a listed project, or a new topic. That is the golden set. It holds real names, so it is not in the repository. `eval/topics-replay.mjs` feeds the loose memories, and 8 that plainly belong to a project, through the pass one at a time, so a topic made early is listed for the ones after it.

| | Topics off (before) | Topics on |
|---|---|---|
| Work facts left in personal | 6 | 0 |
| Same-subject pairs kept together | 0/7 | 7/7 |
| Personal kept personal | 8/8 | 8/8 |
| Project memories kept in their project | 9/9 | 9/9 |
| All | 17/25 (68%) | 23/25 (92%) |

The first run with topics on filed two facts about the person (their browser, their role) under a "team" topic. The prompt now says personal is who they are, their role and what they use, and the rerun kept all 8. The two misses left: the customer personas got nothing in both runs, and the skills repository fact went to `skill-system`, which the blind reader also called unsure.

## What other tools do

We looked at 14 products on 7 October: Claude, Claude Code, ChatGPT, Gemini, mem0, supermemory, Zep, Letta, LangMem, Limitless, Notion, Mem, Tana and Obsidian, plus the PARA method.

| What we found | What we take from it |
|---|---|
| No product lets groups made by the system decide what always loads. | An auto-made topic never loads on its own. Only a repository link, which you make, does. |
| Groups made by the system drift. Zep's clusters need rebuilds, and Tana users ask for duplicate control. | Satchel reuses a topic before it makes one, and the nightly pass can merge two. |
| Mem.ai suggests a group and asks you to accept it. | Same idea, but hands-off: Satchel makes it and tells you, and you can undo it. |
| Claude Code, Letta and LangMem load a small capped core and fetch the rest. | That's how Satchel already works. Nothing changes there. |

## What stays the same

Loading doesn't change. A session still gets:

```
every session
├── always     personal, under the existing block_size cap
├── always     this repository's topic, if exactly one   (D29, as today)
├── listed     the topic index, filtered as today, capped
└── by match   everything else
```

The only difference is that work facts now have a topic to live in, so personal stays small and about you. One small change: with no linked repository, today every project is listed. As Satchel makes topics that list would grow, so it is capped at the 15 most recently used, with a count for the rest.

## What changes

**Capture.** Consolidation already picks one project slug or null for each change. Now it can also give a new topic name when no listed topic fits. Today an unknown slug turns into null (personal). Instead, a new name that is not close to an existing topic becomes a new topic, and a name that is close reuses that topic.

**Tidy.** The nightly pass can merge two topics that are really the same thing. Each merge shows a note in activity with an undo. It never merges a topic that has tasks or repository links, because those are yours to manage. A merge moves the memories first and only then removes the old topic, because deleting a topic still deletes its memories (the foreign key cascades). The delete screen says how many memories go with it.

**Grants.** All or none for topics. A migration must not widen a live grant (security skill), so it goes the other way: existing grants that name specific projects lose topic access, and you reconnect the app once to choose "all". Satchel has one user today, so that is one reconnect per app. The overnight connection and the plugin's connection must have "all" before the capture change ships, or the pass can't see any topics and would make duplicates. So the pass only makes new topics when its own grant is "all". The grant flags for personal, write, tasks and uploads stay as they are.

**Names.** "Project" becomes "topic" in the UI, the tools and the code. The old tool names stay as aliases until the plugin stops using them.

## Decisions

| Question | Decision |
|---|---|
| Are projects kept? | No. They become topics. |
| Memories and topics | A topic has many memories. A memory sits in at most one topic, like a project today. |
| Who makes topics | Satchel or you. Only you add repository links. |
| Grants | All or none for topics. Narrow grants end, and you reconnect once. |
| When Satchel merges topics | A note in activity, with undo. Never for topics with tasks or repository links. |
| A finished project | Nothing special. It just stops getting new memories. |
| People as a topic type | Not now. |

## What has to get done

| # | Area | What it means | Size |
|---|---|---|---|
| 1 | Rename | `projects` becomes `topics`, with the same ids. Database, server, tools (with aliases), UI, tests, docs and the `satchel-projects` skill. Stage it: database with old-name views, then server and tools, then UI, then remove the aliases. | L |
| 2 | Capture | Consolidation can name a new topic. A new name either reuses a close topic or makes one. Update `consolidate.md` the prompt-management way. | M |
| 3 | Tidy | The nightly merge, with a note and undo in activity. | S |
| 4 | Grants | All or none for topics, narrow grants end, security checklist and tests. | S |
| 5 | Backfill | One pass over personal: move work facts into topics. Dry run first. | S |
| 6 | UI | A design pass for the topics page: which ones Satchel made, the merge note, and the first visit after the backfill, when topics appear that you never made. | M |
| 7 | Eval | A blind subagent reads real memories and proposes topics. Tune it until it is right, then use its output as a golden set the pipeline has to beat. Move the existing evals from projects to topics. | M |

## Later, if needed

Each of these came up while reviewing the plan. They are real, but none is needed to fix the junk drawer, and each one can be added later without undoing the above.

- **A memory in more than one topic.** It would change reads, writes, grants, the twin check and about 13 database functions. Add it only if one topic per memory proves too tight.
- **Pinned topics** that always load without a repository.
- **A lifecycle** (forming, active, quiet) and **hidden topics**.
- **Machine-only memories.**
- **People.**

## Open

- How close two topic names have to be before they count as the same. The eval in 7 should set it.
- A rule like "infra tickets go straight to Done" is a work rule, not a fact. If the backfill moves it into a topic, it stops loading everywhere. Proposed: rules stay in personal, and only facts move. Check this in the backfill dry run.
