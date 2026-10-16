# Memory and topics retro · 16 October 2026

A look back at four weeks of the memory and topic system, written from the live database, the daily review logs, the injection golden set and the code on `main`. Every number says where it came from. Nothing here was changed in production.

An independent Opus reviewer read the first draft cold and checked the numbers. What changed because of that review is at the end.

---

## 0. The one screen version

```
 what the person said          what Satchel kept            what the agent got
 ───────────────────           ────────────────            ──────────────────
 1,709 typed prompts    ──►    120 live memories     ──►   27 rows at every session start
 334 host messages             76% never confirmed          1 in 5 prompt-block rows useful
 195 sessions                  78 facts · 39 rules          72% of sessions had no topic
                               117 adds · 0 retires         one rule re-said about 8 times
```

**Where I land: 5/10 is fair.** The pipes are good and well measured. The store they feed is mostly low value, and nothing measures whether the agent follows what it is shown.

Three things explain most of the gap:

1. **The pass keeps design-in-flux as facts.** 9 of the 11 memories the pass ever replaced were skill-system facts, all replaced on one day, each a day old or less when it was replaced. The store churned instead of settling, and every wrong row was in front of the agent while it was wrong.
2. **The store does not know what the agent already has.** Two of the six most needed rows are the writing rules in `~/.claude/CLAUDE.md`, and a third is partly there. The person forgot the em-dash rule on 27 September and the pass added it back on 6 October. Nothing stops a forgotten claim from coming back.
3. **Nobody measures following.** The product doc judges Satchel by "less repeated explanation". The only signal we have for that, how often a rule is said again, is a hint and not proof. But it hints the wrong way: the plan-doc rule loads into every session and has been affirmed about 8 times.

What I would do first, in order:

| # | Move | Side | Mark | Why now |
|---|---|---|---|---|
| 1 | Forget or narrow the broad rows named below | Both | Data | 4 rows took 137 prompt slots in production and helped 4 times. Zero code |
| 2 | A forgotten claim stays forgotten: the twin check also looks at ended rows | Consolidation | New | The em-dash rule came back 9 days after it was forgotten |
| 3 | Label a young, unaffirmed topic fact as `draft` in every block | Consolidation | New | The agent reads "draft, 1 day old" differently from a settled fact; nothing is hidden during a sprint |
| 4 | Show `said N times` on a loaded row and list 3+ in the app | Both | New | The closest thing we have to a following metric, made visible |
| 5 | One weekly review that builds only what was seen three times | Meta | Changed | The loop ships a PR a night because a memory says it must |
| 6 | When a repo names several topics, load the union of their rules | Injection | New | Covers the rules the agent misses in those sessions; but see the limit in J1 |

The rest of this doc is the evidence, section by section. Detail sits behind the `+` rows.

<details>
<summary>+ Words used here</summary>

- **The pass**: the overnight model call that reads one quiet conversation against the memories that exist and decides what to add, extend, replace, retire or affirm. **The tidy** runs once a night before it and moves work facts out of personal into topics.
- **heard / said**: a memory the pass picked up on its own is `heard` (unconfirmed). One the person asked for, or said again, is `said`. An **affirm** is the pass hearing an existing memory again; it turns heard into said and adds one to `mentions`.
- **The block**: what the session-start hook puts in front of the agent: the topics, every personal memory up to a cap of 30, and the active topic's own rows up to 15. **The prompt block** is the up-to-5 rows retrieved for one typed prompt.
- **The golden set**: 161 real sessions and 1,302 typed prompts, each labelled by a blind reader with the memories it needed (`must`, `helps`) and the ones that would mislead (`traps`).
- **reached**: of the prompts that needed something, the share where at least one needed row was in front of the agent. **clean**: the share of prompts where nothing shown was useless. **topic right**: the share of prompts whose active topic matched the labeller's topic. All three come from `eval/injection-real.mjs`.
- **Pro**: the consolidation model since the 13 October night (decided 11 October), `gemini-3.1-pro-preview`. **D23, D28**: rows in `docs/decisions.md`.
- **Mark**: New (does not exist), Changed (exists, alter it), Exists (keep as is), Data (a fix in the stored rows, no code).
</details>

---

## 1. The ethos, and where we drifted

```
 8 Sep product doc              24 Sep (D23)               today
 ─────────────────              ────────────               ─────
 explicit saves only     ──►    hands-off capture    ──►   nightly pass + tidy + topic making
 no curator                     unconfirmed loads          2 review loops, 41 PRs in 3 weeks
 no scheduled pass              pass confirms by hearing   person touched the store 9 times
 judged by "less repeating"     (no metric)                (no metric)
```

The product doc still says there is "no curator, proposal inbox, scheduled consolidation, or automatic transcript extraction". Decision D23 reversed that on purpose, and I think the reversal was right: a memory nobody loads is a rule nobody follows. But the doc and the measure of success never followed the decision.

**What the person actually does with the store.** Hands-off is real. In four weeks the events with no session attached, which is what a hand action looks like, are 6 forgets, 1 restore and 2 corrections. Every `user:` add, replace and confirm up to 7 October carries a pass trace, because the pass ran under the person's own token until it had its own client. So the person touched the store about 9 times while the pass made 117 adds. The three injection reports asked the person to narrow or end broad memories; none of those rows changed. "The person fixes data findings" is a step in the loop that does not happen, and the loop should not depend on it.

<details>
<summary>+ Where the numbers come from</summary>

- Product doc: `docs/product.md`, section 3 ("There is no curator...") and "How we will judge the product".
- D23: `docs/decisions.md`.
- Person's touches: `memory_events` grouped by actor and action, split on whether `document_id` is set.
- Data findings asked three times: `~/satchel-daily/injection-review/2026-10-11/report.md` TODO 5, `2026-10-12/report.md` TODO 3, and the 2 October log entry naming three noise rows.
</details>

---

## 2. What happens on a real session, end to end

```
                 ┌──────────────┐   27 rows, ~1,300 tokens
 session start ──► hook-index   ├──► topics in this codebase
                 │              │    personal (confirmed, then picked up)
                 └──────────────┘    this topic's rules, only if the repo names exactly one
                                     ...or: "repo belongs to 4 topics, call select_topic"  ← almost never happens

                 ┌──────────────┐   30% of typed prompts get a block
 each prompt ────► hook-retrieve├──► embed prompt, search above 0.67, skip what start loaded
                 │              │    drop other-topic rows under 0.75, 5 rows max
                 └──────────────┘    host messages are not searched (good)

                 ┌──────────────┐
 each stop ──────► hook-capture ├──► record the reply into the document; write no memory
                 └──────────────┘

                 ┌──────────────┐   Pro model, 25 to 55 s a session, $0.23 to $0.47 a night
 overnight ──────► consolidate  ├──► tidy personal → topics, then one call per quiet session:
                 │              │    add / extend / replace / retire / affirm, twin check at 0.85
                 └──────────────┘    may name a topic, may link an unclaimed repo

                 ┌──────────────┐
 Tue to Sat ─────► daily review ├──► blind Sonnet read vs the pass, TODOs, build top one, merge
 Mon, Thu ───────► injection rev├──► blind labels vs replay, TODOs, build top one, merge
                 └──────────────┘
```

The numbers at each stage, last four weeks:

| Stage | Number | Source |
|---|---|---|
| Sessions recorded | 195 documents, 141 (72%) with no topic | `documents` |
| Typed prompts | 1,709 typed, 334 from the host | `document_turns` |
| Session start block | 27 rows, 1,325 tokens on average (week of 12 Oct) | `memory_injections` |
| Prompt blocks | 42 blocks for 139 typed prompts (30%) that week | `memory_injections`, `document_turns` |
| Prompt rows useful | about 1 in 5 in production | golden set, 11 Oct |
| Pass | 17 jobs, 245 runs, 117 adds, 11 replaces, 0 retires | `consolidation_runs`, `consolidation_jobs` |
| Store | 120 live: 98 topic, 22 personal · 78 facts, 39 preferences, 3 intents · 91 heard (76%), 29 said | `memories` |
| Nightly cost on Pro | $0.47, $0.23, $0.26 on the three nights logged | `~/satchel-daily/log.md` |

One thing the diagram makes plain: **retire has never fired.** 245 runs, 0 retires by the pass. The code comment that calls retire "the one nothing has ever done" is still true. Intents are 3 of 120 rows, so there is almost nothing to retire. The lifecycle is add, add, add, with 11 replaces, nearly all of them one in-flux fact replacing another.

---

## 3. Where the value actually is

The golden set is the best evidence of value we have. I counted which memories labellers wanted most, and which were shown most without being wanted.

```
 needed most (labelled prompts that wanted it)       shown most on prompts, and how often it helped (production)
 ────────────────────────────────────────────        ─────────────────────────────────────────────────────────────
 plain words, no jargon            79   in CLAUDE.md  Langfuse observability rule        shown 44   helped 1   needed 7
 no em dashes                      70   in CLAUDE.md  "topic linking selects scope"      shown 43   helped 2   needed 4
 plan docs simple and visual       60   partly        "no memory to task linkage"        shown 27   helped 0   needed 2
 pacing queue is first come        57   topic fact    "migration out of scope"           shown 23   helped 1   needed 4
 keep systems simple               55   Satchel only
 comments only when needed         51   Satchel only
```

Three readings:

- **Two of the six most needed rows are already in `~/.claude/CLAUDE.md`, and a third is partly there.** They load into every session twice. The other three are rules and a decision that only Satchel holds, which is the product doing its job.
- **The settled topic decisions are real value:** how email pacing picks from the queue, where planning happens, what `scheduledFor` means. They live in a topic linked to one repo, so they load and retrieve well. This is the product working as meant.
- **The noise is descriptions of code,** mostly of Satchel itself, shown to an agent sitting inside that code. The four rows above took 137 prompt slots in production and helped 4 times. One self-description is now wrong: a memory says a session can be in several topics at once, and the code holds exactly one.

<details>
<summary>+ Needed rows split by scope and kind</summary>

Over the 1,302 labelled prompts, 590 needed something and 712 needed nothing.

| Label | Personal rows | Topic rows |
|---|---|---|
| must | 121 | 136 (118 in the session's own topic) |
| helps | 338 | 712 |

Of the 136 topic `must` rows, 95 are facts, 39 are preferences and 2 are intents. So the topic need is mostly facts, and 87% of them belong to the topic the session is about. That is the case the session-start topic block was built for, and it only loads when the repo names exactly one topic.

The report lists of noise rows differ from mine because they score the replay of today's code, not production. Both lists are right for what they measure. The combined list to look at is in J2.
</details>

---

## 4. Consolidation pipeline

### What goes wrong, with real cases

```
 the skill-system topic, 6 and 7 October (every arrow is a replace by the pass)
 ──────────────────────────────────────────────────────────────────────────────
  6 Oct  "uses s3Prefix + files list"      ──► 7 Oct  "content-addressed hashes per file"
  6 Oct  "reuses the SkillScope enum"      ──► 7 Oct  "not reusing it, evaluating"   ──► 7 Oct  "two flags instead of an enum"
  6 Oct  "clone tracking omitted"          ──► 7 Oct  "a source field"               ──► 7 Oct  "a typed sourceRef on the version"
  7 Oct  "three S3 buckets"                ──► 7 Oct  "one bucket per environment"
  7 Oct  "global edits need internal org"  ──► 7 Oct  "dev mode check"               ──► 7 Oct  "no check, RBAC later"
```

**Pitfall 1. It keeps design-in-flux as facts.** The topic went from 0 to 47 memories in nine days while the design was being argued out. 9 of the 11 replaces the pass has ever made are in this topic, all on 7 October across two pass runs, each row a day old or less when it was replaced (four were written and replaced the same day). So this is one topic in one sprint, not a pattern across the store. But it is the pattern of a sprint, and sprints are when the agent is in that topic every day. The review TODO for it ("in-flux design kept as facts", #27) was seen on 7, 8, 11 and 16 October and never built, because it is a judgment the prompt cannot make from one session.

**Pitfall 2. It describes the code to the agent that is in the code.** The Satchel topic holds 24 memories; about ten of them say how Satchel works (how capture mode is set, how the overnight toggle looks, what the MCP server validates, what the injection eval is). The agent has the repository open. These rows cost prompt slots and one is false.

**Pitfall 3. The source check proves the words were typed, not that the claim will hold.** In session `fa9b20df` (14 Oct) the pass added three skill-system facts from messages another session relayed: a default scope, a token rule and a sandbox ceiling. The blind reader kept none of them. The 16 October review called them stale-prone. Same session: a teammate's PR number stored as "the chosen agent tool", which is a job detail with a date on it.

**Pitfall 4. A forgotten claim comes back.** The person forgot "Do not use em dashes" on 27 September. The pass added it again on 6 October and affirmed it on 14 October. The twin check only looks at live rows, so a row the person ended is invisible to it. I feel this is the clearest single bug in the pipeline, and it is small.

**Pitfall 5. The target is noisy, and was noisier before Pro.** Pipeline against blind by night:

| Night | Model | Pipeline | Blind |
|---|---|---|---|
| 25 Sep | flash | 2 | 32 |
| 28 Sep | flash | 4 | 14 |
| 29 Sep | flash | 4 | 20 |
| 30 Sep | flash | 20 | 23 |
| 1 Oct | flash | 8 | 23 |
| 2 Oct | flash | 2 | 6 |
| 6 Oct | flash | 14 | 18 |
| 8 Oct | flash | 60 | 80 |
| 9 Oct | flash | 9 | 17 |
| 11 Oct | flash | 9 | 32 |
| 13 Oct | Pro | 23 | 25 |
| 14 Oct | Pro | 9 | 10 |
| 16 Oct | Pro | 16 | 5 |

Pro closed most of the gap, which is good evidence the model mattered more than the eleven prompt edits before it. But the reviews themselves say blind readers over-count about half the time, and on 16 October the pass out-wrote the blind reader on rows the reviewer then called stale-prone. A target that moves this much cannot tell a good prompt change from a quiet night.

**Pitfall 6. The best following signal it has goes unused.** `mentions` counts how often a memory was said again (starting at 1, and an extend adds 1 too). The plan-doc rule is at 12 with 3 extends, so about 8 affirms; comments at 9, plain words at 7, act-as-owner at 5. A rule loaded into every session and affirmed 8 times is a hint that the agent is not following it, or that the person says it out of habit. It is a hint, not proof. But it is the only "repeated explanation" number we have, and nothing reads it except the sort order inside the block.

**Pitfall 7. The machinery outgrew the thing it improves.**

| Piece | Lines |
|---|---|
| Server (hooks, pass, service, tools) | 4,853 |
| Plugin scripts | 793 |
| Eval scripts | 2,241 |
| Review skill scripts | 1,362 |
| Skill text (11 skills) | 3,687 |
| Tests (51 files) | 8,701 |

41 PRs merged since 22 September. The last three the daily loop built were "show 500 characters not 300", the same for the tidy, and "share the 500 constant". They are fine. They are also what a loop produces when a memory says it must improve one thing each run.

<details>
<summary>+ What is working and should stay</summary>

- One capable call per session, not one per turn. 37% precision under the old router; the pass's picks held up against a blind read on 23 September.
- Source must be the person's words, kinds decide what can be retired, nothing is deleted. These are the right guardrails and they are cheap.
- Pro model: 12 changes against 2 on the same three sessions, about 9 real. $0.3 a night is nothing.
- The twin question instead of a cosine threshold. Right call, well argued.
- Whole turns, never cut. Right.
</details>

### Simplifications and enhancements, consolidation

| # | Change | Mark | What it does | Pros | Cons |
|---|---|---|---|---|---|
| C1 | A heard topic fact under 7 days old with no affirm is shown with a `draft, N days` label in the start block and the prompt block | **New** | The agent treats it as "check before relying", the way the commits marker already works | No prompt change; nothing hidden during a sprint; one line in `injection-format.mjs` and a filter on `created_at` | Does not remove the row; relies on the agent reading the label |
| C1b | Same, but hold the row out of retrieval until 7 days or an affirm | **New** (alternative) | Removes in-flux rows from view | Kills the 9 replace cases from view | Hides the current decision exactly when the person is in that topic every day; would have hidden the pacing facts for their first week |
| C2 | A forgotten claim stays forgotten: `sameClaim` also searches rows ended as `forgotten`, and a twin there drops the add | **New** | The em-dash case cannot repeat | Small; the nearest-row search exists | A rule the person forgot and then truly changed their mind on needs a hand save |
| C3 | Forget the self-description rows in the Satchel topic, and add one guardrail line: how the product currently works is in the code, keep decisions and rules | **Changed** | Removes the biggest noise source for your own repo | About ten rows; immediate | The pass may write new ones; a prompt edit can come out even |
| C4 | Show `said N times` on every loaded row, and list rows at 3+ in the app as "you keep repeating this" | **New** | Makes the following hint visible to the agent and to you | Tiny; the agent reads a 12 differently from a 1 | A hint, not proof; does not fix following by itself |
| C5 | Relayed-message sessions: when most user turns are host notes, only preferences may be written | **New** | Stops job details from other sessions becoming facts | One check in `validateConsolidation` | Rare so far (seen once) |
| C6 | Turn topic-making off for now (`SATCHEL_NEW_TOPICS=off`); keep the tidy | **Changed** | Two of three Satchel-made topics are empty or one row | Less to review each night | Loses the one good case (infrastructure, 5 rows) |

My recommendation: C2 and C1 first, then C3. C2 is a bug. C1 changes what the agent sees without touching the prompt, and the prompt has had eleven edits in three weeks. I prefer the label over the hold because of the sprint problem.

---

## 5. Injection system

### What goes wrong, with real cases

```
 session "Zip vs individual files", 7 Oct, in the work backend repo (then linked to 3 topics, 4 today)
 ──────────────────────────────────────────────────────────────────────────────────────────────────
 start:  repo belongs to several topics → nothing picked → 14 rows loaded, all personal
 35 typed prompts, 12 "must" rows never shown, among them:
   prompt 6   "raise the file store service..."       needed: skill input is a folder, not a zip   (skill-system fact)
   prompt 11  "tell me the gap, I will post on slack"  needed: short plain Slack voice, no em dashes (personal, past the cap of 30)
   prompt 18  "start on the skeleton PR..."            needed: DTO inputs, classes at boundaries    (backend rules)
```

**Pitfall 1. Six sessions in ten never have a topic.** 108 of 173 collected sessions, 141 of 195 documents. The start block tells the agent to call `select_topic` and it almost never does. 741 of 1,302 labelled prompts (57%) ran in a repo linked to several topics, and topic right there is 5.9% (42% over all prompts). The topic block, which holds the rules the pass catches best, never loads for them.

**Pitfall 2. The prompt block is mostly noise.** In production about 1 in 5 rows shown on a prompt was useful. The four rows in section 3 took 137 slots and helped 4 times. They are broad sentences that sit near everything in the embedding space.

**Pitfall 3. Traps: a true memory that steers this prompt wrong.** Three real ones from the golden set:

- Prompt: "run the redis block test now". Shown: "Redis failure testing is deferred until the cluster".
- Prompt asks for zip-vs-folder options with trade-offs. Shown: "skill input is a folder, not a zip", which pre-decides the question.
- A `/langfuse` command about the company's Langfuse. Shown: Satchel's own "observability must use Langfuse" rule.

**Pitfall 4. Repeats took 54% of prompt slots in production until 11 October.** The skip list and plugin 0.5.2 took that to 0% in the replay. This is the one injection fix that clearly landed. Keep it.

**Pitfall 5. A week went into topic picking and the corrected replay said it is not the bottleneck.** Seven addenda, 1,482 model calls, a 74% single-pick accuracy. Then addendum 7 fixed the replay to use memories as of each prompt and to charge block rows, and every option's gain went to zero or negative. Main's reached was already 89%. I think that is the most useful result of the whole week: routing is not what holds the score down. What is stored is.

**Pitfall 6. What is shown is not what is followed.** Every injection number measures "was the right row in front". None measures whether the reply obeyed it. The mentions count above is the only hint, and it hints no for the rules that matter most.

<details>
<summary>+ Session start block, honestly</summary>

27 rows and about 1,300 tokens per session is cheap. 13 of the personal rows are picked up and unconfirmed, under a header that says use them anyway. I found no measured harm from that, and D23 was the right call. The one cost is that a personal rule past the cap of 30 silently stops loading, which is what happened to the Slack-voice rule in the session above.
</details>

### Simplifications and enhancements, injection

| # | Change | Mark | What it does | Pros | Cons |
|---|---|---|---|---|---|
| J1 | When a repo names several topics, load the union of those topics' **preferences** as the topic block; facts stay with retrieval | **New** | Gives the 57% of unscoped prompts the rules, without the 45-row fact dump the corrected replay charged as negative | Rules are few (backend 7, the others 0 today); no model call; no agent action | Covers at most 39 of the 136 topic `must` rows, and none of the pacing facts; unproven, needs one free replay; today it is really "always load the backend rules" |
| J2 | Forget or narrow the broad rows: in production add027, 71bd0f, cae051, 418bc5; in the replay of today's code the reports add d6c3f4, faf4e7, 68c0a1, dd8089, c195eb | Data | Removes the biggest noise rows | Zero code; ten minutes in the app | Someone has to do it; see J3 |
| J3 | An app list: "most shown, least used" from `memory_injections` against the affirm count, with a Forget button beside each | **New** | Makes the data fix a one-click job instead of a report line nobody acts on | The data already exists | Needs a small page |
| J4 | Label `intent` and deferral rows as such in the prompt block (`deferred`) | **New** | The redis trap reads as context, not as an order | One line in `injection-format.mjs` | Only helps the agent read; does not hide the row |
| J5 | Keep the skip list, the machine-prompt filter, the 0.75 stranger floor, the gate at 0.67 | **Exists** | They are measured and working | | |

My recommendation: J2 today, J3 so J2 is not asked a fourth time, then J1 measured on the existing free replay with its limit stated.

---

## 6. From 5/10 to 10/10

```
 today                                            10/10
 ─────                                            ─────
 reached                 89% (replay)       ──►   95%          keep what works
 clean                   17%                ──►   60%          C1, C3, J2: fix what is stored
 topic right             42% (5.9% in multi-topic repos) ──► 80%   J1 plus repo-level scope
 rules affirmed          up to 8x           ──►   falling      C4 plus a following number in the review
 facts that survive      9 of 11 replaces within 2 days ──► a fact lasts a month    C1
 review loops            2 (Tue to Sat, Mon and Thu), a PR a night ──► 1 weekly, builds what is seen 3x
```

What 10/10 looks like to the person, in plain terms: I open a session in any of my repos and the agent already follows my rules for that codebase. I do not re-say "no em dashes" or "plan first". When the agent is shown a memory, it is a decision we made and it is still true. Memories about half-built designs say so. A claim I forgot stays gone. And I can see, in one place, which memories keep getting shown and never help.

**The product question under all of this.** The product doc promised continuity across apps and devices. As far as I can tell every one of the 195 sessions came from Claude Code on this laptop, where CLAUDE.md already carries two of the top writing rules. So the part of the promise that only Satchel can keep, topic decisions across repos and devices, is the part with the least data behind it. The email-pacing topic shows it works when a repo maps to one topic and the memories are settled decisions. I would make that the test of every change: does it help a decision we made last month reach a session in another repo or another app.

<details>
<summary>+ A simpler shape of the whole system, for comparison</summary>

Not a recommendation yet, just what the evidence points at if I were drawing it fresh.

| Today | Simpler |
|---|---|
| Some writing rules in Satchel and in CLAUDE.md | Satchel knows what CLAUDE.md holds and does not re-add it; a forgotten claim stays forgotten |
| Topic facts written the night they are said, shown as settled | Facts carry their age and a draft label until they survive a week or a second mention |
| Agent asked to pick a topic | Scope is the repo; a repo loads the rules of every topic it is linked to |
| Two review loops, daily, each builds a PR | One weekly review; a change needs the same miss three times |
| Noise fixes asked of the person in a report | A page with the list and a button |
</details>

---

## 7. Open, and decided

**Open** (who decides)

| Question | Decides |
|---|---|
| C1 or C1b: label young facts as draft, or hold them out of retrieval | the owner |
| C6: topic-making off until there is a second user | the owner |
| J1: build the preferences-union block and measure on the replay, knowing its limit | the owner says go; the injection loop builds |
| Review cadence: weekly instead of daily and twice weekly | the owner |
| Whether the writing rules should live in CLAUDE.md only | the owner |

**Decided** (dates)

| Date | Decision |
|---|---|
| 24 Sep | Hands-off capture, unconfirmed rows load (D23) |
| 28 Sep | Keep what was said plainly, bare "yes" carries nothing (D26) |
| 2 Oct | Only typed prompts are searched; skip what the block loaded (D28) |
| 11 Oct | Pro model for the pass; skip the topic block rows on prompts (PR 38, 40) |
| 12 Oct | Topic pick research closed: no option beats main once block rows are charged (addendum 7) |

---

## What the independent review changed

An Opus agent read the first draft with no context and checked numbers against the database and the golden set. All the stage numbers in section 2 and the golden-set counts matched. It found twelve things; the ones that changed the doc:

- "The most needed memories are already in CLAUDE.md" was overstated. It is two of six fully and one partly. Section 0 and 3 now say that, and the claim about Satchel being a second copy is gone.
- The noise rows had two different counts in two sections. There is now one table (shown, helped, needed) and one total, 137.
- The 7-day hold (now C1b) would hide decisions during a sprint and would have hidden the pacing facts for a week. The label (C1) is the recommendation instead, and the replaces are described as one topic on one day.
- J1 covers at most 39 of 136 topic `must` rows and none of the pacing facts. That limit is now in the table and J1 moved down the list.
- `mentions` counts extends too, so "re-said 12 times" became "affirmed about 8 times", and it is called a hint.
- The hand-touches footnote was wrong about when the pass got its own token. Fixed from the events table.
- The pitfall on noisy targets quoted the four worst nights. It now shows all thirteen logged nights, including the three Pro nights that were close.
- The reviewer found the em-dash re-add in the history. That became pitfall 4 and move 2.
- Small drifts: 24 Satchel rows not 27, 7 backend rules not 6, snapshot of 16 October, 4 linked topics today.

Two findings I left as they were: the 1,300-token start block is called cheap because it is, and the "machinery outgrew the thing" table stays because the line counts are the evidence.

---

## Addendum, same day: five scenarios walked through the code

After this retro, five agents each walked one scenario through the code and the data, read only. Their reports are on the page "How Satchel Remembers" (Part 10). Three things they found change what is written above:

- **Scenario C shrinks pitfall 1 of section 5.** In the "Zip vs individual files" session, the 12 "must" rows never shown were all written after the prompt that needed them. Across all 86 labelled sessions in that repo, 127 of the 133 missed needed rows did not exist yet, and only 6 were real misses, all facts that search already reaches. Scope loses the rules block only, and the narrow topics have 0 rules today. J1 stays the recommendation, with that limit, and the shipped replay must first serve memories as of each prompt or it will overstate the gain.
- **Scenario D makes J4 a non-fix.** Of the 9 trap rows shown in production, 8 are facts and 0 are intents, so labelling intents would catch none. Narrowing two rows removes 5 of 9; a skill line saying a retrieved row is context and the prompt wins covers all 9 but the replay cannot measure it.
- **Scenario A found an order bug in move 2 as shipped.** The forgotten check ran before the live-twin check, so a claim forgotten and then saved again would be refused forever instead of affirmed. Fixed and merged the same day (PR 49): live twin first, and the same check on replace.

Scenario B sharpened pitfall 1 of section 4: the since-replaced rows were shown mostly after the decision had changed, 45 showings of 6 rows, up to eight hours each, because the pass runs at night and nothing shows age. Scenario E confirmed pitfall 6: the plan-doc rule was in the start block on 8 of 8 re-says, so being in front is not enough.

## Appendix: how the numbers were made

All queries ran read only through the Supabase management API with the token in `~/.config/env`. Golden-set counts came from `~/satchel-daily/injection-eval/` (snapshot taken 16 October, labels written 11 and 12 October, 161 labelled sessions). Nothing was written anywhere.

<details>
<summary>+ Queries</summary>

```sql
-- store shape
select band, kind, (topic_id is null) as personal, count(*) from memories
 where ended_at is null group by 1,2,3;

-- what ended, and what replaced it
select m.created_at::date, m.ended_at::date, m.ended_reason, m.statement, n.statement
  from memories m left join memories n on n.id = m.ended_by where m.ended_at is not null;

-- pass activity by day
select created_at::date, count(*), sum(added), sum(extended), sum(replaced), sum(retired), sum(affirmed)
  from consolidation_runs group by 1 order by 1;

-- injection load by week
select date_trunc('week', created_at), event, count(*), sum(array_length(memory_ids,1)), avg(tokens)
  from memory_injections group by 1,2;

-- most shown on prompts, last 14 days
select m.id, left(m.statement,100), count(*) from memory_injections i, unnest(i.memory_ids) mid
  join memories m on m.id = mid where i.event = 'UserPromptSubmit' group by 1,2 order by 3 desc;

-- who touched the store, and whether a session was attached
select action, split_part(actor,':',1), (document_id is not null), count(*) from memory_events group by 1,2,3;

-- sessions with and without a topic
select (topic_id is null), count(*), sum(turns) from documents group by 1;

-- the em-dash rule's history
select created_at::date, action, actor, left(after,60) from memory_events
 where memory_id in (select id from memories where statement ilike '%em dash%') order by 1;
```

Golden-set counting: for each labelled prompt, the ids Satchel showed were compared with the labeller's `must`, `helps` and `traps` lists; "needed" is must plus helps, "helped" is shown and needed on the same prompt. "Shown" in section 3 counts production injections on the labelled prompts only, not every injection in the table, which is why the query above gives larger totals. The "Zip vs individual files" session is `1beb9134` in `injection-eval/sessions/`.
</details>
