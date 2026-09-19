# Memory v2: automatic capture and earned injection

20 September 2026. **Proposed design, nothing implemented.** Direction agreed in discussion with the user; mechanisms are proposed unless marked otherwise. Supersedes nothing yet: [Memory and storage](memory-and-storage.md) and [Current memory hooks](memory-hooks.md) still describe the shipped system.

Measurements in this document come from probing the user's own Supermemory account (container `repo_satchel__ed7ddf2ea405cab5`) and reading `~/.claude/plugins/cache/supermemory-plugins/supermemory/0.1.8/` on disk, on 19 September 2026. They are evidence about a competing product, not about Satchel.

A visual companion to this document exists as a private artifact: <https://claude.ai/artifact/MErnf4Z4GY9CmrK6XvvXt9>.

---

## 1. What this is

A design for memory that captures itself. Today Satchel only stores what the user explicitly asks it to store. That mechanism is reliable but it fires only when the user remembers to fire it, so coverage depends on the user treating memory as a thing to manage.

Memory v2 adds one small model call at the end of each turn. It reads what the user said, decides whether any of it is worth keeping, and writes it down in a sentence that will still make sense in six weeks. Everything else about Satchel stays as it is: the tables, the revisions, the grants, the conflict-on-stale semantics, and explicit saves.

## 2. Why

### 2.1 The problem with explicit-only saves

Satchel's current design puts all of the uncertainty on the user. There is no confidence field anywhere in the schema, so whenever something is unclear the only component able to hold "unclear" is the person. Scope ambiguous, ask the user. Worth keeping, the user decides. Relevant now, the user reminds.

The design did not remove the uncertainty. It routed all of it to the human, which is why memory feels like a concept the user has to think about.

Both halves are half-solved in opposite directions:

| | mechanism | trigger |
|---|---|---|
| Write | deterministic and correct | fires only when the user remembers |
| Read | index loads deterministically | the model may or may not use it |

### 2.2 The problem with capturing everything

The obvious fix is to capture automatically. Supermemory and Mem0 both do this, and the measured result on the user's own account:

| Measure | Value |
|---|---|
| Items in the profile Supermemory built | 87 |
| Of those, actual preferences | **1** |
| Items that were transient state | 19 |
| Memory nodes in the graph | 570 |
| Real semantic edges among them | **28** |
| Cosine threshold gating injection | `0.55`, a hardcoded constant |
| Typical per-prompt injection | 223 tokens |
| Of that, a fixed instruction paragraph | **58%**, resent every prompt |

Nineteen items were things like "A Chrome tab is open at 127.0.0.1:5173 awaiting the user to click Continue with GitHub" and "Supermemory MCP server not reachable, retries in about 15 minutes." The tool stored its own outage as a durable fact about the user.

This is not an extraction bug. Supermemory's schema has exactly one stored type: `POST /v3/documents` with a free-form `metadata` blob, where `metadata.type` is an unvalidated string. A project is a `containerTags` string. A task cannot be represented at all. Every record is a thing that happened, so the store fills with things that happened.

Their noise control, per `~/.supermemory-claude/settings.json`, is a keyword list:

```json
"signalExtraction": true,
"signalKeywords": ["remember", "architecture", "decision", "bug", "fix"]
```

It is off by default.

### 2.3 The gap this design occupies

The choice is usually framed as explicit saves versus a curator. That bundles two independent questions: who authored the content, and what caused the write to happen.

| | content by user | content by agent |
|---|---|---|
| **user triggers** | today's Satchel. Safe, rare. | "write up your summary" |
| **auto triggers** | **this design** | the rejected curator |

Automatically capturing a claim the user actually made is not the agent inferring anything. The rule that keeps it in the safe quadrant is section 4.3.

## 3. What a memory is

**User decision.** A memory is one sentence. The three-field shape of name, description and `more_info` is the wrong object model.

Measured across the user's 87 real captured statements:

| | |
|---|---|
| Median length | 133 characters |
| Mean | 141 |
| p90 | 236 |
| Longest | 330 (and that one is a CSS changelog, arguably not a memory) |
| Fitting in the existing 280-char description | **95%** |

`more_info` is sized for 40,000 characters and is null on nearly every row.

The diagnosis: the index-then-fetch protocol was modelled on skill loading, and [Memory and storage](memory-and-storage.md) says so explicitly. A `SKILL.md` runs to thousands of tokens, so progressive disclosure is right for it. A memory is 141 characters. The right pattern was applied to the wrong object.

Three consequences:

1. **The index gets smaller.** Statement-only is ~1.8k tokens at 50 memories against ~2.3k for name-plus-description. Carrying the whole memory costs less than carrying a summary of it, because the summary had a name stapled to the front.
2. **`read_memory` leaves the loop.** A complete index has nothing to fetch. This removes a tool call, a round trip, the `expected_id` staleness check, the reused-name detection, and the failure mode where the agent never bothers to fetch details.
3. **It makes automatic capture safer.** With a name and a description, the router must invent a handle and write a summary. With one statement field it authors far less. See 4.3.

Long content is not a memory. A long procedure is a **skill**. A long document is a **resource**, an attached HTTPS link. Both concepts already exist. `more_info` exists because memory was sized for documents before those two were separate from it. Keep the column so nothing is lost, flag it in the index, stop designing a protocol around a field that is almost always null.

## 4. The router

A small model call at the end of each turn. It is not an agent: no tools, no ability to call anything, no access to stored memories.

### 4.1 Input

```
system
  [fixed instructions]
  projects:   satchel, reimbursement, cbx-backend
  open tasks: fix-consent-layout  — Fix the corner leak on the consent page
              add-abuse-limits    — Add rate limiting before the pseudo-launch

context — for understanding only, never a source
  last 5 user messages       in full
  last 3 assistant replies   first ~800 chars each

classify
  <turn> the user's messages from the turn that just ended </turn>
```

Roughly 1.3k tokens. Tasks carry **slug and title**: the title so the model can tell what was meant, the slug so it returns something exact.

It never sees stored memories, any UUID, or anything outside that rolling window.

### 4.2 Output

**User decision.** A list, not a single object, because one sentence often carries several memories. The user's own `CLAUDE.md` contains "plain 8th-grade words, no jargon, no metaphors, no em dashes, first person," which is five separate rules.

```
[ { statement, source, project?, task? } ]
```

An empty list is the "no", which removes any need for an is-this-a-memory flag. Most turns return it.

Worked example:

```
you › ok so no personas in v1, and don't use em dashes anywhere.
      also the consent page still has that corner leak on .paper

[
  { statement: "no personas in v1",
    source:    "no personas in v1",
    project:   "satchel" },

  { statement: "don't use em dashes anywhere",
    source:    "don't use em dashes anywhere" },
    // no project = personal, loads everywhere

  { statement: "the consent page has a corner leak on .paper",
    source:    "the consent page still has that corner leak on .paper",
    project:   "satchel",
    task:      "fix-consent-layout" }
]
```

Three shapes from one turn: a project decision, a personal rule belonging to no project, and a problem linked to the open task. Any design that cannot express all three is wrong, and several earlier ones could not.

### 4.3 Statement versus source

**User decision.** Verbatim was the wrong guarantee.

If a memory must be the user's exact words, the burden of phrasing lands back on the user, and every sentence carries a background question about how it will read later. That is memory-awareness in every keystroke, which is what this design exists to remove. Real example:

```
said:        "project makes sense, but which project it has to output, make
              project name unique for a user and then make the llm output that"

verbatim:    unusable. a reply to something, no subject, reads as noise later.

the claim:   "project names should be unique per user, and the router
              outputs the name"
```

Two things were bundled under one rule and only one needed blocking:

| | |
|---|---|
| **Fabrication** | asserting something the user never held. The real danger. |
| **Rewording** | the same claim, said clearly. Harmless and necessary. |

So the guarantee changes from *verbatim* to *traceable*. `statement` is the readable rendering and is what loads. `source` is the span the user actually typed, stored and never loaded. Any dispute about whether a memory is real is settled by looking.

**Allowed:** fix grammar, drop filler, resolve a pronoun whose referent is in the same turn, keep the user's vocabulary.

**Not allowed:** add reasoning, widen scope, merge two statements into one claim, introduce a term the user did not use.

```
ok:  "project names should be unique per user, and the router outputs the name"
no:  "project names must be unique per user because uuids are unreliable for LLMs"
      ^ the user never said why. that is the router deciding what they meant.
```

The test is not "did they say these words." It is **would the user recognise this as their claim**.

This is why the router needs a context window. Cleaning up "make the llm output that" requires knowing what "the llm" refers to. But context is for understanding only: `source` must still be a span from the user's message in the current turn, so the assistant's replies can inform the reading and can never become a memory.

**Splitting:** split only where the parts already stand alone. "no jargon" and "no em dashes" split cleanly. "no personas and no curator in v1" would need glue to become two, so it stays one. Bias toward fewer, larger memories.

**Known limit:** a sliding window does not reach the start of a long thread. Something said at message 60 that only makes sense given framing from message 3 will be skipped or cleaned badly. This is roughly the right bias: if the last few turns are not enough to make a statement comprehensible, a fresh session with no context certainly will not be.

### 4.4 Slugs, never UUIDs

**User decision.**

A slug looks like an identifier, so a model copies it. A title looks like prose, so a model rewrites it and the exact match fails. A UUID is 36 characters a model will quietly transpose.

Slugs are **supplied on create, not derived**. Deriving produces `fix-the-corner-leak-where-the-shell-background-pai`, which nobody would say and which a model matches against worse than the title.

- `slug` is a required argument on `create_task` and `create_project`
- validated server-side against `^[a-z0-9]+(-[a-z0-9]+)*$`, 3 to 40 characters
- unique **per user**, not per project, so the model gets one thing right instead of two
- `23505` on collision, the agent picks another and retries
- `slugify()` is written once, only to backfill existing rows

The agent writing a slug does not violate the no-fabrication rule. That rule governs memory statements, which become claims about what the user decided. A task is something the user asked to be created, its title is already agent-written, and the slug appears in the reply immediately.

Slugs pay for themselves outside this feature: "resume fix-arch-concern" beats pasting a UUID, and a memory row says what it points at without a join.

### 4.5 Resolution, done by the hook

The router's return type contains exactly the things that needed judgment. Everything else is a lookup the hook performs.

| Model returns | Hook writes |
|---|---|
| no `project` | personal scope |
| `project` matches a slug | that UUID |
| `project` matches nothing | personal scope |
| no `task`, or no match | `task_id` null |
| `task` matches an open slug | that UUID |

No fuzzy matching. The defaults point at the harmless failure: personal scope loads everywhere, so a missed project flag is visible noise the user deletes, while the reverse traps a personal rule in one repo where its absence is never noticed.

## 5. Injection policy

**User decision.** Only personal memory is always loaded. Everything else is retrieved at runtime.

### 5.1 Why load-everything does not work

[Projects](projects.md) states that a repository "can belong to one or more efforts." One codebase can carry ten projects, and ten projects at a hundred memories each is a thousand rows. Deriving the active project from a git remote was never valid, because a git remote identifies a repository and a repository maps to many projects.

Tasks will also grow epics and subtasks. Loading a whole task tree does not scale.

### 5.2 Why retrieve-everything does not work either

```
memory:  "don't use em dashes anywhere"
prompt:  "can you write up the plan"
cosine:  nowhere near any usable threshold
```

That memory is relevant to every writing task and semantically similar to none of them. Standing preferences are relevant by **category of activity**; embeddings measure topic overlap. The rules the user cares about most are exactly the ones similarity retrieval is worst at.

### 5.3 The rule

**Session start carries only what applies no matter what you do. Everything else is earned by something you said.**

| What | When | Size |
|---|---|---|
| All personal memories | always | ~40 rows, ~1.4k tok |
| The projects list, slug and one-line brief | always | ~20 rows, ~400 tok |
| Everything else in authorized scope | retrieved per prompt | ~300 tok, falling |

Personal rules pass the test: "don't use em dashes" is true whatever you open today. The projects list passes: you need to know what exists in order to scope a save, and that is true regardless. Project memories and task memories fail, because loading them assumes you will touch that project or task.

Nothing scoped to a project or a task is injected at session start.

An earlier draft had a middle tier that always loaded the open task's memories, behind a setting defaulting to on. It is cut. `in_progress` is a status on a row, not a statement about the current session, and [the tasks reference](../integrations/shared/context/references/tasks.md) says so directly: "`in_progress` is a coordination signal, not a lock." A task can sit in that state for days. The weak-prompt case it was meant to cover ("ok continue", which matches nothing on its own) is already handled by the topic terms the `Stop` hook caches, so the query searches against the previous turn's vocabulary.

Making it a setting instead of deciding was avoiding the decision.

Personal scope is not configurable. Turning it off breaks what the product is for.

### 5.4 Scope is a ranking boost, not a filter

Retrieval searches everything the connection is authorized for, and weights by what is actually in play. All signals are free and computed in SQL.

```
score = similarity
        × 1.1   project touched this session   -- saved to, read from, or already
                                                  returned a hit this session
        × 1.1   project linked to this repo    -- deterministic, from the git remote
        × 1.0   everything else
```

Weights were measured, not guessed, in the [build plan](memory-v2-build.md) section 4.9. An earlier draft used 3.0 and 2.0 with a 0.7 demotion for closed tasks. All three were wrong. A multiplier acts on a score in [0,1], so 3.0 reorders everything globally: it gains +0.073 when it points at the project you are asking about and loses 0.493 when it does not, which needs 87% of a session's prompts to be about that one project just to break even. 1.1 gains +0.077, the same benefit, and loses 0.022. The closed-task demotion is contradicted outright: memories hanging off closed tasks are 8.5% of the corpus and 11.4% of what human labelling calls relevant. The shape is the point: **a project earns its boost by being used, not by being guessed at.** The first mention of an unrelated project wins on text alone, and from then on it ranks higher because it has actually been touched.

### 5.5 Use cases, traced

| What the user does | What happens | Result |
|---|---|---|
| Fresh session, "let's fix the consent page layout" | FTS on the prompt; satchel boosted 2x from the remote | works |
| Fresh session, "what was I doing" | Matches no memory. It is a task question, so the agent calls `list_tasks`. | works, via tasks |
| Mid-session, "ok continue" | Prompt matches nothing; the query also uses the terms `Stop` cached last turn | works |
| "actually let me look at the reimbursement thing" | "reimbursement" is distinctive and wins on text; that project is now touched and boosted 3x afterwards | works |
| "write up the plan", where the em-dash rule must apply | Already loaded. This is why personal is always-on. | works |
| "for reimbursement, always convert at the RBI rate", typed inside the satchel repo | The router sees the projects list and returns `project: "reimbursement"` | works |
| "no, that's wrong, it's X" | The memory is in context, personal or retrieved this turn; corrected by handle | works |
| "forget the serif headings thing" | Retrieval finds it on the text, then it is deletable | works |
| A memory whose task has closed surfaces | Returned with `[fix-consent-layout · closed 20 Sep]`; the agent announces the doubt | works |
| Repo with no linked project | Projects list still loads, no boost, pure text ranking, saves default to personal | degraded, sensible |
| Phone or companion with no repo at all | Same as above | works |

### 5.6 The case that breaks

A project rule about **how you work** that you never lexically mention.

```
memory:  "always run the tests before pushing in satchel"
prompt:  "push that up"
FTS:     almost no overlap. probably misses.
```

Identical to the failure that makes personal memories always-loaded, except this one is project-scoped so it is not.

Two ways out, in order of preference:

1. **It is probably a personal memory.** A rule about your habits that happens to name a project belongs in personal scope, where it loads everywhere, which is correct because you would want it in any repo. The router should lean personal when a statement is about the user's habits rather than the project's state.
2. **If that proves wrong, add a pin.** One boolean, set by the user and never by a model, meaning "load this whenever its project is in play." Off by default, so nothing is preemptively injected unless it was asked for. **Build when:** the injection log shows a specific rule repeatedly missed.

Ship without the pin and find out, rather than adding a flag for a case that cannot yet be pointed at.

### 5.7 Fixing the specific failures observed

| Observed in Supermemory | This design |
|---|---|
| `0.55` cosine over everything | narrow to this repo's projects first, rank inside that. 1000 candidates becomes ~100. |
| top 5, silently truncated | print counts: `4 shown · 11 matched · 130 in scope` |
| model cannot tell "no rule" from "did not score" | the same line fixes it |
| 4s round trip to a remote API | own Postgres, ~100ms, 500ms timeout, fail open |
| re-injecting the same rows | session-scoped set of injected IDs; anything already in context is never sent twice |
| 128 tokens of instructions per prompt | instructions in `SKILL.md`; the per-prompt block is data only |

The last two together mean per-prompt cost **falls** over a session as the working set accumulates in the conversation. Supermemory's stays flat because most of it is boilerplate they resend.

### 5.8 Start with Postgres full-text, not vectors

**Proposed.** `tsvector` and `pg_trgm` are already available, cost nothing per write, add no service and no embedding latency. `vector` is not available in the PGlite build the test suite runs on, so an embedding design cannot be tested in the harness that already exists while this one can. Memory statements are short and share vocabulary with the codebase, which is what full-text search handles well. Where it loses is paraphrase, and that is measurable from the injection log (section 8). Ship FTS, log the misses, add pgvector when the misses can be pointed at.

## 6. Hooks

A turn is the user's message plus the agent's entire response including all tool calls. `Stop` fires once, at the end. A message sent mid-turn joins the running turn rather than starting a new one.

| Hook | Does | Cost | On failure |
|---|---|---|---|
| `SessionStart`, compaction | projects with briefs, all personal memories | ~1.8k tok, once | say so; never claim memory loaded when it was not |
| `UserPromptSubmit` | one FTS query on prompt + cached terms, minus already-injected IDs | ~300 tok, falling | personal is still present; degraded, not broken |
| `Stop` | router captures; caches ~10 topic terms | ~1.3k tok in, async | nothing captured; explicit saves still work |

Every hook degrades to something usable. Nothing regresses past today's behaviour.

The two hosts do not support the same hooks, and the differences change the design rather than just the packaging. Codex cannot inject context from `Stop` or from `PostCompact`, has no `last_assistant_message`, and skips the `prompt` handler type entirely. The full comparison, and what each difference forces, is in the [build plan](memory-v2-build.md) section 3.

### 6.1 What `SessionStart` injects

```
<satchel>
projects
  satchel         Context that follows you across AI apps
  reimbursement   Monthly RazorpayX claims from bills and statements
  cbx-backend     Content pipeline work

personal — confirmed, use freely
  a3f291  don't use em dashes anywhere
  7c04b8  never add yourself as coauthor on commits

personal — not confirmed, mention these before relying on them
  5b7f03  never propose a development timeline unless it's in scope

more exists — search satchel for anything not listed above
</satchel>
```

Six-character handles so a delete or correction can name a row. No UUIDs, no timestamps, no relevance scores, and **no description of what Satchel is**, because that is the 128-token paragraph measured in 2.2.

**The headers carry the instructions.** An earlier draft had a separate three-line `rules` preamble. Folding those rules into the group headers is cheaper (a header only exists when its group is non-empty), harder to skip since the instruction sits beside the rows it governs, and removes the dependency on `SKILL.md`'s body having loaded. Skill bodies load lazily, so a block that explains itself is the only version that always works.

### 6.2 What `UserPromptSubmit` injects

```
◪ retrieved · 2 shown · 5 matched · 130 in scope
  0c28d1  no personas in v1
  4d1b77  the consent page has a corner leak on .paper
            [fix-consent-layout · closed 20 Sep, may be fixed]
```

The counts are what let the agent tell "there is no rule about this" apart from "nothing scored high enough", which is the failure Supermemory's top-5 truncation causes.

The `[task · closed]` suffix appears only here, never at session start, because a closed task's memories are only ever surfaced by something the user actually said.

### 6.3 Why `Stop` caches topic terms rather than prefetching

What the agent just said is a better topic signal than the user's next bare prompt. "so for the v1 scope" is weak on its own; the previous reply carries the vocabulary. So `Stop` writes about ten terms to a session file and the next prompt's query uses both.

Prefetching the whole retrieval at `Stop` was considered and rejected, because the next turn may change topic entirely and the ~100ms it would save is not worth a stale topic.

An earlier draft also argued that `Stop` probably could not inject at all. That was wrong. [Claude Code's hook documentation](https://code.claude.com/docs/en/hooks) says `Stop` supports `hookSpecificOutput.additionalContext` and delivers it as a system message on the next turn. Codex is the opposite: its `Stop` accepts only `continue`, `stopReason` and `systemMessage`. So the rejection stands on the topic-change argument alone, and it now also holds on the cheaper ground that a prefetch design would work on one host and not the other.

## 7. Going stale

**User decision.** The task link asks a question. It never deletes.

```
memory has no task_id            → never questioned
memory has task_id, task done    → announces a doubt before it is used
                                 → user says "fixed" and it goes,
                                   or "still broken" and it stops asking
```

Deleting on `done` was an earlier design and it was wrong three ways. A task reaching done is not proof the problem is fixed. A wrong link would destroy data silently. And it puts the checkpoint at a moment the user is not present for, instead of the moment it matters.

There is no lifetime enum, no condition flag, no trigger and no deletion. A memory either points at a task or it does not, and the behaviour follows from that one link.

**Open:** standing preferences that go stale with no event to mark them. "I prefer serif headings" stops being true one day and nothing observes it. Not solved.

## 8. Visibility and settings

**User decision.** The user must be able to see exactly what gets sent.

[Product](product.md) section 8 already asks for this: inspect the app's "current context," and "a context preview should use the app's effective permissions." It is specced and unbuilt.

```
What Claude Code sees in this session

  projects              20 rows     400 tok
  personal              38 rows   1,340 tok
  ─────────────────────────────────────────
  session start                   1,740 tok

  per prompt            last 10   ~240 avg, falling
  ─────────────────────────────────────────
  today                           4,100 tok      [ preview ]
```

Two requirements keep it honest:

- **Preview renders the exact bytes** that get injected, not a description of them. A summary means auditing the summary.
- **Every per-prompt injection is logged**: which rows, on which prompt, from what query. This is the only way to answer "why did it say that" or "why did it not know that", and it is the same data that decides whether FTS recall is sufficient (5.5).

### Settings

| Setting | Default | When to change |
|---|---|---|
| Per-prompt matches | 5, `0` disables | too noisy, or too thin |
| Session-start budget | 15k tokens | over it, the load reports `complete: false` and names the overflowing scope |

Two, down from three; the open-task toggle went with the tier it configured. Personal memory has no toggle. Per-project overrides are possible later since per-project config already exists as a concept.

Settings live in Supabase and the hook reads them in the same call that fetches the index, costing no extra round trip.

## 9. Data model

```
memories
  id, project_id, revision, updated_at
  statement    text ≤500                -- readable. this is what loads.
  source       text                     -- user's words. stored, never loaded.
  band         'said' | 'heard'         -- derived from HOW it was captured
  task_id      uuid → tasks(id) | null  -- only when the router named a task
  search       tsvector, GIN            -- retrieval index
  more_info    text | null              -- rare. flagged, not loaded.
  name         text | null              -- optional handle. most rows have none.

tasks / projects
  slug         text, required, unique per user
```

`band` is not a model decision. Auto-captured is `heard`, explicitly saved by the user is `said`. A `heard` memory becomes `said` when the user confirms it, and that is the whole promotion rule. There is no counting of announcements and no `promoted_by` column: an earlier design had both to enforce a distinction nobody had complained about.

Removed relative to earlier drafts: `description` and `quote` (merged into `statement` and `source`), `kind` and `lifetime` (gone entirely), `closes_when` (became `task_id`, and it never deletes), `injected` and `cited` (deferred).

## 10. MCP surface

| Tool | Change |
|---|---|
| `memory_index` | becomes a scoped search rather than the injection path |
| `read_memory` | only for the rare row flagged as having `more_info` |
| `save_memory` | explicit saves land as `said`, bypassing the router |
| `correct_memory`, `delete_memory` | unchanged; take the six-character handle |
| `create_task`, `create_project` | gain a required `slug` argument |
| `confirm_memory(id)` | **new.** promotes `heard` to `said`. |

One new tool.

## 11. Build order

1. **One sentence in `SKILL.md`.** "If a memory is unconfirmed, say it out loud before relying on it." No model, no migration, no dependency. Today a shaky note and a hard decision arrive as identical flat text. Independent of everything below.
2. **Collapse the memory shape.** `description` becomes `statement`; add `source`, `band`, `task_id`; `name` nullable; `more_info` a flag.
3. **Slugs on tasks and projects.** Required on create, validated, unique per user, backfilled once. Useful on its own.
4. **Rewrite the `SessionStart` injection.** Per 6.1. Projects and personal memories only.
5. **`tsvector` + GIN, and the per-prompt hook.** Retrieval with the scope boost of 5.4, the counts of 6.2, and the already-injected exclusion of 5.7.
6. **The `Stop` hook.** Router capture plus topic-term caching.
7. **The context panel.** Per section 8. This is what proves whether any of the above works.

### Deliberately deferred, with the trigger for each

| Item | Build when |
|---|---|
| pgvector and embeddings | the injection log shows FTS missing things that can be pointed at |
| A per-memory pin, loading a project rule whenever its project is in play | the log shows a specific project rule repeatedly missed, and moving it to personal scope did not fix it (5.6) |
| `injected` / `cited` counters | retrieval quality becomes the complaint rather than capture quality |
| Capture rules learned from rejections | the same category has been rejected three times |
| Few-shot keeps and deletes in the router prompt | the log has enough rows to matter; it does nothing on day one |
| GEPA prompt evolution | a few hundred keeps and deletes exist. Metric already defined: deletion rate down. |
| Auto-created tasks and evidence entries | probably never. Creating a task is a deliberate act nobody minds asking for; memory capture was the only real problem. |
| A graph database | never. Foreign keys are the graph and they are typed. |

## 12. Open questions

- **Where the router runs.** In the hook on the user's machine, which needs an API key per machine but keeps conversation text off Satchel's servers, or on the Satchel server, which is one key to rotate but means Satchel receives rolling windows of real conversation. The second contradicts text Satchel ships today in `bootstrap.mjs` and [Current memory hooks](memory-hooks.md). Not a reason it cannot be done, a reason it cannot be done quietly. See the [build plan](memory-v2-build.md) section 5.5.
- Standing preferences that go stale with no observable event (section 7).
- Scope migration: [Memory and storage](memory-and-storage.md) notes that moving a record between scopes is unsupported. Automatic capture makes wrong-scope guesses more likely, so this becomes more valuable.
- Whether the router runs against OpenRouter's free zero-retention tier or a local model. The router sees a rolling window of real conversation, so zero retention is a hard requirement either way, and local is preferable.
- Whether Claude Code expands `${session_id}` inside an `mcp_tool` hook input. Its documentation says it does not, which would mean the shipped compact-path load has been passing a literal string as the session key. Listed with its test in the [build plan](memory-v2-build.md) section 12.

## 13. Rejected along the way

Recorded so they are not re-litigated. Each was proposed in discussion and abandoned for a stated reason.

| Idea | Why it was dropped |
|---|---|
| Build retrieval improvements first | Supermemory has a working per-prompt retrieval reflex and still surfaced "Satchel memory plugin is working" into a design conversation. Retrieval can only pick the least-bad row available. Capture is the bottleneck. |
| A router on the read side, choosing which memories to inject each prompt | The index is already in context. Paying a model to choose from something already present is the waste being removed. |
| Loading the whole index at session start, zero cost per prompt | A repository maps to many projects, so the scope is unbounded. Held only at toy scale. |
| Cutting the task link entirely to shrink the schema | Would have tagged permanent personal rules to whatever task happened to be open, then flagged them stale when it closed. The most valuable memories would have been the most damaged. |
| A `lifetime` enum of standing / conditional / transient | `transient` is not a lifetime, it is the absence of a memory, and it disappears once the output is a list. `conditional` collapsed into the presence of a task link. |
| Deleting conditional memories when their task closes | Silent data loss from a model's guess, and a task reaching done is not proof the problem is fixed. |
| The router returning `kind` of memory / task / evidence / none | Only memories needed automatic capture. Task creation is a deliberate act; evidence has an explicit tool. |
| A `condition: true` boolean | Meaningless with several tasks open, and "condition" was invented vocabulary the model would have to be taught. |
| Returning task titles rather than slugs | Titles invite the model to paraphrase. Slugs look like identifiers, so they get copied. |
| Deriving slugs from titles | Produces unusable strings from long titles. |
| Verbatim-only statements | Puts the burden of phrasing back on the user, which is the problem the design exists to remove. |
| Prefetching retrieval at `Stop` for the next turn | The next turn may change topic. Claude Code can inject from `Stop`; Codex cannot, so it would also have worked on one host only. |
| Three-strikes automatic promotion from `heard` to `said` | Two extra columns and a counter to enforce a distinction nobody had complained about. |
| Always loading the open task's memories at session start | `in_progress` is a status on a row, not a statement about this session, and a task can sit in it for days. Paying every session for work that may not be touched. |
| Making that a setting instead of deciding | Configurability used to dodge a decision. The answer was cut it. |
| A separate `rules` preamble in the injected block | The same boilerplate criticised in 2.2, defended only on arithmetic. Self-describing group headers are cheaper and cannot be skipped. |
| Grouping injected rows by task | Invented a third grouping axis that the schema does not have, and reading `satchel · fix-consent-layout` as a heading makes it look like a task rather than memories from one. |

Several of these were the same mistake: shrinking the schema and calling it simplifying. Two were the reverse, adding preemptive loading and calling it helpful. The only test that catches either is a concrete case.

## 14. Sources

- Supermemory plugin 0.1.8 source, read from `~/.claude/plugins/cache/supermemory-plugins/supermemory/0.1.8/` on 19 September 2026: `hooks/hooks.json`, `hooks/recall-directive.js`, `hooks/session-start.js`, `hooks/lib/api.js`.
- The user's Supermemory account via `POST /v4/profile` and `POST /v3/documents/list`, container `repo_satchel__ed7ddf2ea405cab5`.
- [Supermemory Claude Code integration docs](https://supermemory.ai/docs/integrations/claude-code)
- [Mem0 add-memory docs](https://docs.mem0.ai/core-concepts/memory-operations/add) and [Mem0 Codex integration](https://docs.mem0.ai/integrations/codex)
- [OpenRouter zero data retention](https://openrouter.ai/docs/guides/features/zdr)
- [Vercel AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing)
- TypeSafe AI's System One / Jev announcement, which started the discussion and supplied the framing of a typed, calibrated decision as a primitive.
