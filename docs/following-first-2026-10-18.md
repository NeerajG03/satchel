# Following first · 18 October 2026

**Status:** decided 19 Oct (section 6), nothing built yet. **Decides:** Neeraj. **Reviewed by:** an independent reviewer and a cold reader. What changed because of them is in section 7.

This is the design for the next goal: **when Satchel shows a rule, the agent follows it, so you never have to say it twice.** It has two parts:

- **A. Production parity.** Find out whether real sessions behave like today's code, and take a noisy line off the per-prompt memories.
- **B. A following score.** Count how often you had to correct the agent on a rule Satchel had already given it, and put that number first in the daily report.

Neither part changes which memories exist or which ones get picked.

---

## Words used here

| Word | Meaning |
|---|---|
| **start block** | The memories Satchel puts in front of the agent when a session begins (up to 30 personal ones, plus the active topic's) |
| **prompt block** | The up to 5 memories Satchel adds when you type a message, picked by how close they are to what you typed |
| **the nightly pass** | The overnight job that reads your finished sessions and adds, updates or re-counts memories |
| **affirm** | The nightly pass noticing you said an existing memory again. It adds one to that memory's count |
| **complaint / up-front** | How each affirm is labelled. *Complaint*: you said it after the agent got it wrong. *Up-front*: you said it out of habit, before any answer |
| **injection review** | A report that replays past sessions through the code and scores what the agent was shown against hand labels of what each message needed |
| **real-sessions column / today's-code column** | The injection review's two columns: what real sessions were actually shown, and what today's code would have shown on the same messages |
| **reached** | Of the messages that needed a memory, the share where it was shown |
| **every row useful** | The share of messages where nothing shown was useless |
| **repeat** | The share of prompt-block rows that were already shown earlier in the same session |
| **harmful** | Count of rows shown that would have misled the agent |
| **utility** | One score from the injection review that rewards needed rows and charges for every row shown |

---

## 0. The one screen version

```
 Satchel finds the right memory          ███████████████████  90%   reached
 every row shown was useful              ███▍                 17%
 start-block rows the agent used         ██▋                  13%
 you corrected the agent on a rule       14 times in 4 weeks, 10 of them in the week of 5 Oct
   Satchel had already given it
```

The finding part is working. The following part is not. And neither report shows that on its first line today.

### You decide

All four were answered on 19 Oct, each as the lean below. See section 6.

| # | Question | Yes means | No means | My lean |
|---|---|---|---|---|
| 1 | A3: drop the "repo has moved N commits" line from preferences and rules | Shorter prompt blocks; the line stays on facts | Nothing changes | Yes |
| 2 | A3: for a fact about a repo you are not in, shorten the line instead of keeping it as is | A one-line "may be out of date" note | The full line stays | Yes |
| 3 | A2: add a plugin version stamp to every hook call | We can tell old plugins from bugs for good | We rely on the local check in A2 this time | No for now, check locally first |
| 4 | B4: a change that says it helps following must report the score's 4-week trend | Every such change is checked against it | The score stays a report line only | Yes, as a direction, not a pass or fail |

Everything else in this doc needs nothing from you. No database migration, no model prompt change, no paid model calls.

**What you will notice:** fewer bracket lines under prompt-block rows (A3), and the daily report opens with the following score (B3). The memories you see do not change.

---

## 1. Why this, and why now

```
 the rule (already in your start block)       times you corrected the agent on it, Oct
 ──────────────────────────────────────       ──────────────────────────────────────
 4fa6dd  code comments only when needed       ████  4
 1db602  plain, simple English                ███   3
 bf351a  plan docs simple, visual, readable   ███   3   (about length and visuals)
 ec7960  act as owner, merge on green         ██    2   (both may be plain instructions)
```

Source: `~/satchel-daily/2026-10-17/said-again.md`, 19 Sep to 17 Oct. 33 affirms in all: 14 complaints, 8 up-front, 11 not labelled. 13 of the 14 complaints were about a rule already in that session's start block.

But "already in the start block" is not proof on its own. All 8 up-front affirms were in the start block too, because these rules load into almost every session. What it does show is that loading a rule is not enough. You still had to say it 14 times, and the agent had it the whole time.

A separate read of 80 local sessions (3 to 17 Oct, not saved, so take the counts as rough) found about 12 times you asked for shorter or simpler answers by hand, in about 10 sessions.

From your side, an agent that ignores a rule it was given looks the same as Satchel not working. So I feel this is the problem to own next, more than finding, which is at 90%.

**One thing the current design works against.** Today a rule that is in the start block is never shown again in a prompt block, so it is not repeated. But the complaints seem to happen deep into long sessions, far from where the start block was. Showing the matching rule again, right at the message where it applies, is probably the strongest lever we have. It would push "repeat" above 0 on purpose. That is the first test the following score (B) should judge, once it exists.

---

## 2. Part A: production parity

### What the injection review compares today

```
 19 Sep ────────── 11 Oct server fix ──── 16 Oct plugin 0.5.6 ──── 17 Oct
 │◄─────────── real-sessions column: every collected session ───────────►│
                                           today's-code column: today's code, replayed
```

| | real sessions | today's code |
|---|---|---|
| repeat | 51.1% | 0.4% |
| harmful | 8 | 2 |
| utility | 0.643 | 0.738 |

Source: `~/satchel-daily/injection-review/2026-10-17/report.md`.

That gap looks like a big live bug. But part of it is just history:

1. **The real-sessions column has no date cut.** `eval/injection-real.mjs:186` adds every collected message, and line 203 scores all of it together. So three weeks of old code are mixed in.
2. **The server follows `main`.** Vercel deploys `main` on every push (`.claude/skills/contributing/SKILL.md:52`), so the server runs today's code as long as the build succeeds.
3. **Old plugins never sent the "already shown" list.** The list of rows a session has seen lives on your laptop (`integrations/shared/shown.mjs`) and is sent with each message. Plugin 0.4.9's hook scripts do not send it at all. It arrived in 0.5.2 on 11 Oct. Three of the four sessions that repeated after the fix (6eb3bdad, b2320e68, 6e8b9cef) very likely still ran 0.4.9, because every newer plugin folder on this laptop is dated 16 Oct.

But not all of it is history. The fourth session, d1ec1aa9 (13 to 16 Oct, resumed 4 times), has an "already shown" file on this laptop. So it ran a plugin that sends the list, and it still repeated. Things that could explain that:

- The server works out what was in the start block again at each message (`server/lifecycle.mjs`, around lines 263 to 284), instead of remembering what was actually sent. In a session that runs for days, the top 30 personal memories can change in between.
- The lookup of the active topic's rows gives up and returns nothing if it is slow.
- Picking a topic partway through a session changes which rows count.

And the replay builds the start block and the prompt blocks from the same moment in time, so its 0.4% may be low partly by construction.

The counts in the report also need a recount. It says repeats fell from 51.2% to 28.9% over 97 slots after the fix, and that 26 of 81 repeat slots were in sessions started after it. Those two do not add up to one story.

### A1 · Split the real-sessions column by date · Changed

The injection review shows two real-sessions columns: **since** a cut date and **before** it. The cut date is one setting in `eval/injection-real.mjs`, set by hand when a plugin or server fix ships. For the first run I'd use 16 Oct 18:27 UTC, when 0.5.6 was installed, because 11 Oct still has 0.4.9 sessions in it.

- **Proof:** the "since" column's repeat and harmful numbers are reported next to today's code. Nothing must move. It is a measurement fix.
- **Cost:** none. The replay runs locally.

### A2 · Find the repeat cause before building anything · New

1. Recount the repeats after the 11 Oct fix, per session, so the 26 / 81 / 97 numbers agree.
2. For each repeating session, work out its plugin version from the laptop (the plugin folder dates and the "already shown" files) and its transcript.
3. Add a replay setting that builds the start block as it was when the session began, not at each message. If repeats appear in the replay with it on, the cause is the server working out the start block again (the first bullet above).
4. Only if steps 1 to 3 cannot settle it: the plugin sends its version on every call, and the server writes it into the trace it already keeps. The script already retries without new fields if an older server refuses them (`integrations/shared/retrieve.mjs:48`, `session-start.mjs:91`), so this cannot break anything.

- **Proof:** every repeat after the fix has a named cause.
- **What you will notice:** nothing, unless step 3 finds a bug. That fix would be its own small design.

### A3 · Only warn about commits when it can matter · Changed

```
 today, in a backend session (seen 9 Oct):
   <a satchel-topic row about the skills repo>
             [neerajg03/satchel has moved 102 commits since this was confirmed, check before relying on it]
```

`server/injection-format.mjs:105` adds this line to any prompt-block row whose repo moved 25 or more commits since the row was confirmed. It ignores what kind of memory the row is and which repo you are in. The rough session read saw it on more than half of prompt blocks.

The change:

| Row | Today | Proposed |
|---|---|---|
| A preference or rule | full line | no line. Commits do not make a preference wrong |
| A fact about the repo you are in | full line | full line |
| A fact about another repo | full line | `[may be out of date]`, short |

I'm keeping a short line for facts about other repos because cross-repo work is real. For example, session 6e8b9cef worked in a frontend repo on skill creation and was shown skill-system facts from another repo. And the agent can still check another repo with `gh`.

- **Proof:** the replay shows the same rows, so reached, harmful and utility stay the same, and prompt-block size goes down. The replay also gives the real share of blocks that carry the line today, replacing the rough count.

---

## 3. Part B: the following score

### What it is

```
 complaints about a rule that was already in the start block, per week

 week of 21 Sep   █                1
 week of 28 Sep                    0
 week of  5 Oct   ██████████      10
 week of 12 Oct   ██               2   (through 17 Oct, a partial week)
```

**The score:** complaints about a rule that was in that session's start block, **per 100 sessions, over the last 4 weeks.** Lower is better. Next to it, three plain counts: up-front affirms, complaints about rules not in memory yet, and affirms not labelled.

Why 4 weeks and not one: at about 3 complaints a week, one week to the next is mostly chance. Over 4 weeks, I feel only a big change, about half as many or fewer, will be clear. So the score shows a direction. It is not a pass or fail.

Why rules not in memory yet are counted on the side: if you correct the agent on a rule Satchel never had, that is a problem with saving memories, not with following them.

The parts already exist. `said-again.mjs` (decision D42 in `docs/decisions.md`) finds affirms and checks whether the rule was in a start block for that session. What is missing is the total session count, full labels, and a place at the top of the report.

### What is wrong with the count today

| Gap | Effect | Fix |
|---|---|---|
| No total of sessions to divide by | 10 then 2 could just mean fewer sessions | B1 |
| 11 of 33 affirms have no label | The score undercounts | B2 |
| One reviewer labels, and some lines are ambiguous | The two ec7960 complaints may be plain instructions, so 13 might really be 11 | B2 |
| The text of each nightly run is deleted after 30 days | The trend cannot be rebuilt later | B3 keeps it |
| "In the start block" means any start of that session, including a resume days later | It is a hint, not proof the agent had it fresh | Said plainly in the report |
| It only sees what the nightly pass notices | A repeat the pass misses is not counted | Later, see section 4 |

### B1 · Count sessions · New

`said-again.mjs` also counts the distinct sessions that got a start block that week, from the `memory_injections` table. It counts distinct session ids, because a resume or a clear writes another start row for the same session. It only reads, using the same database helper it already uses.

### B2 · Label every affirm · Changed

Today the script prints a `mark:` line only for rules said 2 or more times, so the other 11 never get labelled. The script changes to print one for every affirm, and the score line says `unlabelled: N` when any are left. It adds one rule for ambiguous lines: if you were giving an instruction rather than correcting the agent, the label is `up-front`.

### B3 · The headline · Changed

The daily report and its log entry both open with one line:

```
following: 13 complaints in 4 weeks, per 100 sessions: X · 4 weeks before: Y · up-front 8 · new rules 0 · unlabelled 0
```

X and Y come from B1. The weekly counts are also added to `~/satchel-daily/following.json`, so the trend survives the 30-day delete.

### B4 · Changes report against it · New

A change that says it helps following (showing a rule again where it applies, a shorter start block, rules in `CLAUDE.md`) writes down the score on the day it ships. The daily review reports the 4-week direction after it. It is a direction to read beside everything else, not a gate.

### Options for the score itself

| | Complaints the nightly pass finds (recommended) | A model checks each reply against the loaded rules | You rate replies |
|---|---|---|---|
| What it sees | Times you corrected the agent on a known rule | Every reply, rule by rule | What you choose to rate |
| Pros | Exists today, free, built on what you actually said | Catches a broken rule even when you let it go | Direct |
| Cons | Misses the times you gave up and did not say it. Small numbers | Paid calls every night. The checker can be wrong too | You will not rate every time. Needs new UI |
| Cost | none | about one call per reply | your time |

**My lean: the complaint count now.** It is free and it is your own words. The checker is worth building only if the complaint count drops while you still feel the agent ignores rules. That would mean you stopped saying it, not that the agent got better.

---

## 4. Not in this design

| Item | Why not now |
|---|---|
| Showing a rule again at the message where it applies | The first thing to test once B exists (section 1) |
| A shorter start block | Needs B first, to see if it helps |
| Rules in `CLAUDE.md` vs the start block | Same, B is how we judge it |
| Picking one topic in repos linked to several | Measured best case is about +0.02 utility |
| A second check on missed complaints, from a separate read of each session | Only if the score and your own sense disagree |
| Task handoff | Not used since 3 Oct. The memory core comes first |

---

## 5. Order and proof

```
 A1 split column ─────┐
 A3 commit line ──────┼── one PR each, replay before and after, merge when checks pass
 B1 + B2 + B3 ────────┘   one PR, review scripts only
 A2 steps 1 to 3 ──────── an investigation, no PR unless it finds a bug
 B4 ───────────────────── one line in the daily-improvement skill, after B3
```

| Piece | Files | What must move | What must not |
|---|---|---|---|
| A1 | `eval/injection-real.mjs` | nothing, it is a measurement fix | today's-code column |
| A2 | none, unless step 3 or 4 is needed | every repeat has a named cause | n/a |
| A3 | `server/injection-format.mjs`, tests | prompt-block size goes down | reached, harmful, utility |
| B1 to B3 | `said-again.mjs`, its test, the daily-improvement skill and report shape | the score line exists, with a per-100 rate | nothing in production |
| B4 | `.claude/skills/daily-improvement/SKILL.md` | n/a | n/a |

Each piece gets a row in `docs/decisions.md` when it ships.

---

## 6. Decided

| When | What |
|---|---|
| 18 Oct | The next goal is following, not finding (this doc) |
| 19 Oct | A3: drop the commits line from preferences and rules (decision 1, yes) |
| 19 Oct | A3: facts about another repo get the short `[may be out of date]` line (decision 2, yes) |
| 19 Oct | A2: no version stamp for now; check the repeat cause locally first (decision 3, no) |
| 19 Oct | B4: changes that claim to help following report the score's 4-week direction, not a gate (decision 4, yes) |

---

## 7. What the reviews changed

| Review said | Changed |
|---|---|
| "13 of 14 in the start block" is close to the base rate, since up-front affirms were all in the start block too | Section 0 and 1 lead with the 14 complaints and say plainly what "in the start block" does and does not prove |
| A weekly rate on about 3 events cannot judge a two-week before and after | The score uses 4 weeks, and B4 is a direction, not a gate |
| The real-sessions gap is not only history; one repeating session did send the "already shown" list | A2 lists the other causes and checks them first; the version stamp became a last resort |
| The repeat counts in the report do not add up | A2 step 1 recounts them |
| Hiding the commit line on facts about other repos can hide real staleness | Those facts keep a short line |
| Never re-showing a start-block rule may be working against following | Named in section 1, first test for B |
| Count distinct sessions; label every affirm in the script; keep new rules out of the score | B1, B2 and the score's side counts |
| The rule-to-complaint mapping in the first draft was off | Section 1 now uses the said-again counts only |
| Terms, decisions and references needed outside context | Glossary at the top, one "You decide" table, no unexplained IDs |
