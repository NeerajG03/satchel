# Topics

Proposed · 7 October 2026, built by 8 October (see the status table below). Direction agreed with Neeraj in conversation. This replaces the project model in [projects.md](projects.md).

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

The database says topic too: the `topics` table, `topic_id`, `topic_repositories`, `upsert_topic` (D34, D35).

A memory with no topic is personal, just like a memory with no project was before. The database keeps it that way, because "no topic means personal" is built into about 13 functions and the `personal` grant flag. In the UI and the tools, Personal shows as the first topic, pinned at the top, marked "always loads".

## Why

Today the only way to group memories by subject is to make a project. So anything without a project lands in personal.

On 7 October, 5 of the 14 personal memories were work facts with no project (base images, the monitoring tool, VPN rules). They load into every session, including ones that have nothing to do with them. Personal had turned into a junk drawer.

If Satchel can make a topic when nothing fits, those facts get a home, and personal goes back to being about you.

## First experiment: the pass makes topics (built, 7 October)

The smallest piece that proves the idea: items 2 and 5 below, with no rename and no migration. At that point a topic was stored as a project, because projects could already be made by an agent connection.

- The pass can name a new topic when a work fact fits no listed project. A name that is a near spelling of a listed one reuses it (`nearSlug` in `server/consolidator.mjs`).
- It only does this on a connection that sees every topic and may write. Otherwise it behaves exactly as before. `SATCHEL_NEW_TOPICS=off` turns it off.
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

The only difference is that work facts now have a topic to live in, so personal stays small and about you. One small change: with no linked repository, every topic is listed. As Satchel makes topics that list would grow, so it is capped at the 15 most recently used, with a count for the rest.

## What changes

**Capture.** Consolidation already picks one topic slug or null for each change. Now it can also give a new topic name when no listed topic fits. Today an unknown slug turns into null (personal). Instead, a new name that is not close to an existing topic becomes a new topic, and a name that is close reuses that topic.

**Tidy.** The nightly pass can merge two topics that are really the same thing. Each merge shows a note in activity with an undo. It never merges a topic that has tasks or repository links, because those are yours to manage. A merge moves the memories first and only then removes the old topic, because deleting a topic still deletes its memories (the foreign key cascades). The delete screen says how many memories go with it.

**Grants.** All or none for topics. A migration must not widen a live grant (security skill), so it goes the other way: existing grants that name specific topics lose topic access, and you reconnect the app once to choose "all". Satchel has one user today, so that is one reconnect per app. The overnight connection and the plugin's connection must have "all" before the capture change ships, or the pass can't see any topics and would make duplicates. So the pass only makes new topics when its own grant is "all". The grant flags for personal, write, tasks and uploads stay as they are.

**Names.** "Project" becomes "topic" in the UI, the tools and the docs. The app lives at `/topics`, and the tools are `list_topics`, `upsert_topic` and `select_topic`, with `topic_id` on every call. The tables, columns, routines and code names say topic too, since the `20261009090000_topics_everywhere` migration (D35).

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

Status on 8 October.

| # | Area | What it means | Status |
|---|---|---|---|
| 1 | Rename | What a person or an agent reads says topic: the rail, the topics page at `/topics`, the topic page, the consent page, the agent tools and their fields, the docs and the skills. A topic with a repository or tasks is what a project was. The database and the code followed in `20261009090000_topics_everywhere.sql`: tables, columns, routines and code names all say topic (D35). | Built |
| 2 | Capture | Consolidation can name a new topic, and reuses a close one. Topics it makes are marked `made_by = 'satchel'` (`create_satchel_topic`). | Built |
| 3 | Tidy | One call a job, before sessions are read: moves work facts out of personal and merges topics that are one subject. Only topics Satchel made are merged away, never one with tasks or repositories. Every merge is recorded in `topic_merges` and can be undone from the topics page. | Built |
| 4 | Grants | The consent page offers every topic or none. Existing grants are left as they are: on 8 October every live connection already had every project, so nothing needed narrowing. | Built |
| 5 | Backfill | The tidy is the backfill: its first run moves what sits in personal today. | Built, runs on the next job |
| 6 | UI | "made by Satchel" on the list and the topic page, a Merged section with Undo merge, a notice on a merged topic, and "Apps with access" now counts apps granted every topic. | Built |
| 7 | Eval | `eval/topics-replay.mjs` for capture and `eval/tidy-replay.mjs` for the tidy, both against the blind golden set. The golden file holds real names and is passed in by path. | Built |

### How a move and a merge work

```
move_memory(id, revision, topic)      the same row, a new topic
  ├── wording, band, how often it was said: unchanged
  ├── caller must be able to write on both sides
  └── memory history gets a "moved" event: personal → infrastructure

merge_topic(from, into)               from must have no tasks or repositories
  ├── its live memories move to into, each with a "moved" event
  ├── from is kept, hidden, with merged_into set
  └── topic_merges remembers exactly which memories moved

unmerge_topic(from)                   Undo merge on the topics page
  └── moves back only those memories, if they are still where the merge put them
```

### Tidy results on real memories

The 14 memories that sat in personal on 7 October, three runs of one call each:

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Stayed in personal, should | 8/8 | 8/8 | 8/8 |
| Moved, should | 6/6 | 6/6 | 6/6 |
| Same-subject pairs together | 4/4 | 4/4 | 4/4 |
| Topics made | customers, infrastructure, windtunnel-cloud | same | same |

A merge probe with two near-duplicate topics and two that only share a word merged the duplicates both times and left the others apart.

## What carries over from the project model

These held for projects and still hold for topics.

- **A topic is not a repository.** It can have none, one or several. A local clone path belongs to one machine and is never a topic's identity.
- **The UUID is the identity, the slug is a handle.** Renaming a topic must not orphan its memories or tasks. Two topics can share a name, so tell them apart by slug or ID, never by name.
- **A topic is a label, not a permission.** Check access to the topic and to anything it links before returning content. A link can exist without the right to fetch what it points at.
- **Native app projects stay with the app.** A Claude or ChatGPT project may point at a Satchel topic through the plugin or its instructions, but Satchel does not keep an editable copy of a topic's brief in every app.

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
