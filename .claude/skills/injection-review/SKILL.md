---
name: injection-review
description: Review what Satchel put in front of the agent on real prompts against a golden set labelled blind from the person's own sessions, find the gap that costs the most, and build the fix as a PR that merges only when the replay numbers move the right way. Use for the scheduled injection review, or when asked why the agent was shown noise, why a memory it needed was not there, why the same memory keeps coming back, or whether a retrieval change is an improvement.
---

# Injection review

The daily review watches what Satchel writes. This one watches what it reads back: the start block and the prompt block, on the prompts the person actually typed.

It answers the question one way only: a labeller reads the same conversation without seeing what Satchel showed and says what each prompt needed, and the shipped injection code is replayed on the same prompts and scored against that. A change ships when the replay says it is better, on the person's own data, with no model call in the scoring.

It reads production and the local Claude Code transcripts, keeps everything private in `~/satchel-daily/injection-eval/`, then builds the top TODO as a pull request and merges it when it is green. It runs on its own schedule and writes to the same `~/satchel-daily/log.md` as the daily review.

## Where this came from

On 11 October every prompt block in three weeks of sessions was read by eight agents. About 1 in 5 memories shown on a prompt was useful. The rest were noise (39%), repeats of something already in front of the agent (38%), or memories the person had just reversed (5%). In about 6 sessions in 10 no topic was ever picked. The consolidation side had a blind read, an eval and a daily fix. The read side had one audit script. This skill is the read side's version of that loop.

## The pieces

| Piece | What it does |
| --- | --- |
| `scripts/collect-injections.mjs` | Snapshot of settings, topics, links and every memory with its vector (read only). Every settled Claude Code session Satchel ran in, turned into moments: one prompt each, with what was typed, the repository, any topic selected, and what Satchel actually injected, parsed back to ids. Blind files with Satchel's text cut out, the label prompts, and the prompt vectors (the only paid call, cents). |
| `references/blind-label.md` | The label prompt. Per typed prompt: `must`, `helps`, `traps`, and the topic the work belongs to. |
| `scripts/parity.mjs` | Runs the same recent queries through production's `search_memories` and through the twin, on the current data. Must be 100%. |
| `eval/injection-real.mjs` | Replays every session through the real `sessionStart` and `retrieve` from a checkout, on the snapshot, and prints the scorecard for production and the replay, the memories that cost the most, the second labeller's check, and the gate. |
| `eval/lib/injection-twin.mjs` | The stand-in service, and `search_memories` in JavaScript. |
| `eval/lib/injection-scoring.mjs` | The scorecard and the gate. Pure; `tests/injection-eval.test.mjs` checks it. |

The private folder:

| Path | What |
| --- | --- |
| `snapshot.json`, `vectors/memories.json` | The memory set the gold is judged against, and its vectors |
| `sessions/<id>.json` | One session's events: starts, prompts (typed or host), what was shown, topic selections |
| `blind/<id>.md`, `blind/memories.md` | What the labeller reads |
| `blind/prompt-<name>.txt`, `blind/INDEX.json` | The filled label prompts for the sessions not labelled yet |
| `gold/gold-*.json`, `gold/check-*.json` | The labels, and the second labeller's for one session in ten |
| `vectors/prompts.json` | Prompt vectors by hash |
| `baseline.json`, `runs/` | The last main run, and every run |

## Rules

Everything in the daily review's Rules applies here unchanged: production stays read only (no database, memory or topic writes, ever), code changes go through a PR from a worktree off `origin/main`, merge only on green as its own command, no AI co-author lines, secrets stay in `~/.config/env`, conversations stay in the folder, every run leaves a log entry, and the shared checkout is not touched. Read them in `.claude/skills/daily-improvement/SKILL.md`.

Three more:

- **Settings are proposals.** The gate, slot count and caps live in a `memory_settings` row, which is a production write. Score a settings change in the replay with `--set gate=0.70 --set per_prompt_matches=3`, put before and after in the report, and ask. Never apply it. A run with `--set` refuses `--update-baseline`.
- **Data is a finding.** A memory that matches everything, a memory that is wrong, a repository linked to the wrong topic: name the id and the evidence in the report. The person fixes it.
- **Label each session once.** New sessions only. Never relabel to get a different number.

## Cost

| Step | Paid calls |
| --- | --- |
| Collect | Only prompt vectors for new prompts: a few cents for a few hundred |
| Label | One Sonnet agent per batch of new sessions, plus the check batch. The first full set (158 sessions) was about 2.1M agent tokens; a normal run is a handful of sessions |
| Parity | Vectors for new queries only, cents |
| Eval | None. Every run of every checkout is free, so run it as often as it helps |

## Setup

```bash
REPO=/Volumes/Casesensitive/Github/satchel
git -C $REPO fetch -q origin main
WORK=$(mktemp -d)
git -C $REPO archive origin/main | tar -x -C $WORK
# The archive has no dependencies; embedding a new prompt imports `ai`.
ln -s $REPO/node_modules $WORK/node_modules
cat > $WORK/env.sh <<SH
REPO=$REPO; WORK=$WORK; SKILL=$WORK/.claude/skills/injection-review; EVAL=$HOME/satchel-daily/injection-eval
SH
```

Shell variables do not survive between commands. Start every later command with `source <the WORK path>/env.sh &&`.

If Google rejects `GEMINI_API_KEY` (401 on every call), embed through OpenRouter instead, in the process only: `export SATCHEL_EMBEDDING_PROVIDER=openai SATCHEL_EMBEDDING_URL=https://openrouter.ai/api/v1 SATCHEL_EMBEDDING_MODEL=google/gemini-embedding-001 SATCHEL_EMBEDDING_KEY="$OPENROUTER_API_KEY"` before collect and parity. Parity must still match; if it does not, stop.

Stop and log, without building anything, when: collect or parity fails on a missing `SB_TOKEN` or `GEMINI_API_KEY`; a label batch fails twice; parity does not match and the twin cannot be fixed in this run; or step 4 says the baseline is from another snapshot after you already re-collected.

## Steps

### 1. Collect

Read the end of `~/satchel-daily/log.md` first, and answer the last injection entry's "watch next" in this run.

```bash
node $SKILL/scripts/collect-injections.mjs --checkout $WORK
```

It takes a fresh snapshot every run, collects sessions quiet for 12 hours that have no labels yet, and writes `blind/INDEX.json`. A session is labelled whole, once.

### 2. Prove the twin

```bash
node $SKILL/scripts/parity.mjs --checkout $WORK
```

Run it straight after collect, before labelling: it refuses a snapshot that any memory change has made stale, and the nightly pass edits memories. If it says the snapshot is stale, run collect again (it skips labelled sessions) and then parity. It must say the twin matches. If it does not, the replay numbers mean nothing: fix `eval/lib/injection-twin.mjs` against the latest `search_memories` migration as this run's TODO, and do not build anything else.

### 3. Label

For each entry in `$EVAL/blind/INDEX.json`, start a background agent (`subagent_type: general-purpose`, `model: sonnet`, all in one message) with the one line `Read <EVAL>/blind/prompt-<name>.txt and do exactly what it says.` The labellers see `blind/` and nothing else, never `sessions/`, the repository or the database. If the index has no prompts, skip to step 3.

When they are back, check that each output file parses and names every session in its batch. Rerun a batch that failed, never one that only gave answers you did not expect.

### 4. Score main

```bash
node $WORK/eval/injection-real.mjs --checkout $WORK --update-baseline
```

This is the baseline for this snapshot. Do not collect again after this step: a new snapshot makes this baseline incomparable, and the eval will refuse to gate. Typed prompts with no label yet (a failed batch) are listed and left out; say how many in the report.

The replay is as of each prompt. The stand-in serves the memories that existed at that prompt's own time, a label that names a memory written later is dropped (nothing could have shown it), and a prompt left with no need at all is left out rather than scored as quiet; the `as of each prompt` line says how many were scored and how many left out. A need that had been ended by then counts as a trap. Production is judged on the same as-of gold, so the two columns stay comparable. Every run records its ruler (`method: as-of-1`); a baseline scored the old way, or on another snapshot, is not compared, and the eval says to run main with `--update-baseline` first. Read the whole output:

- **The scorecard**, production against replay. Production is what people got; the replay is what main gives today on the same prompts. A gap between them is either code that has already shipped, or the memory set having changed since. `utility` charges the start block's rows on the first scored prompt after they load, and a charged row earns its room when any prompt before the next reset needed it; `utilityFree` is the same number with block rows free, the old headline, kept so a block that grows reads as a cost. `blockRows` is how many rows were charged and `blockUseful` how many of them some prompt in that stretch needed. The gate uses `utility`.
- **Replies marked ▣.** The agent is asked to mark the part of an answer a Satchel row shaped. The collector sets `cited` on those prompts and strips the mark from the blind files; the eval prints how many marked prompts the labeller said needed a memory. A mark on a prompt that needed nothing is a row the agent leaned on that a careful reader would not have. It is a signal to read beside the gold, never a score.
- **Wording.** The start block's median tokens and the once-a-session miss notes, with their cost. The scorecard cannot see guidance lines, because they show no row.
- **Shown and not needed.** The memories that cost the most room. A memory here every run is either too general for retrieval (a data finding) or a sign the gate or the skip list is wrong (a code TODO).
- **Needed and not in front of the agent.** Usually a topic not being picked, or a gate too high for short prompts.
- **Traps shown.** Each one is a wrong instruction handed to the agent.
- **By how the repository is linked.** No link, one topic, several topics. A low "topic right" on several topics means nothing picked one; a low clean on one topic usually means the repository is linked to the wrong topic (a data finding).
- **The second labeller.** If it says the two labellers disagree on which version is better for a number, do not gate on that number, and say so in the report.
- **The labellers' "missing" notes** in `gold/`. Something the person needed that is not stored is a capture gap: put it in the report for the daily review, it is not this loop's to fix.

### 5. Trace each gap

Put every gap in one bucket and confirm the cause in code under `$WORK` with `file:line`. If you cannot confirm it, say it is a guess.

| Bucket | Where it lives |
| --- | --- |
| A host message got a block | `server/machine-prompt.mjs` markers |
| A repeat of something already in front | the skip list in `retrieve`, `server/lifecycle.mjs` |
| No topic, or the wrong one | `resolveScope` and the choose-a-topic line in `server/lifecycle.mjs`; repository links (data) |
| A memory that matches everything | its wording (data), or the gate (settings) |
| Noise from a stale marker, a cut line, the block's shape | `server/injection-format.mjs` |
| Needed but under the gate | the gate and slots (settings), or the query `classifyPrompt` builds |
| Never stored | the daily review |

### 6. Write the TODOs

Write `~/satchel-daily/injection-review/<date>/report.md`. Carry forward the newest earlier report's TODOs the same way the daily review does: done with its commit, seen again with a raised count, or kept. Every TODO has a priority, what to change, the evidence (session ids and the counts from the eval), where, and which scorecard number should move.

### 7. Build the top TODO

Pick the highest TODO that one small PR can close. Skip one that needs a production write, a decision only the person can make, or more than a few files, and say why.

**Ask before a radical change.** If the real fix is a different approach, not a small tweak (a new way to pick a topic, a new shape for the block, a change in who decides what), do not default to a smaller fix that will hit a wall, and do not build the radical one alone. Put the idea in the report with the options side by side (pros and cons), ask Neeraj in the final message, and build the next TODO that is safe. In a session where the person is present, use AskUserQuestion instead. A small fix that only moves a number a little inside a known limit is fine to build; a fix that the replay already shows cannot reach the gap is not.

1. **Build** in a worktree from `origin/main`. Add or extend a test in `tests/injection-eval.test.mjs` or beside the code it changes.
2. **Prove.** `node eval/injection-real.mjs --checkout <worktree>` from the worktree, against step 4's baseline (same snapshot and same method, or it refuses). The gate must pass and the number the TODO named must move. If it does not move, do not open the PR; log what you tried. Then `npm test` and `npm run build`.
3. **Open the PR** with the scorecard before and after, what is not proven (the replay cannot see whether the agent follows a memory it was shown), and what a user will feel, as a before and after (what the person got on a typical prompt then, what they get now, with a real example from the replay in a few words).
4. **Review it** with the `code-review` skill at `high`, fix every real finding, and re-run the eval after the fixes.
5. **Merge on green**, as its own command. Mark the TODO built in the report and remove the worktree.

No PR, and say why in the log, when: the top TODO is a settings change or a data fix (those go in the report for the person), the gate fails, or the named number does not move. If checks are still pending when you finish, leave the PR open and say so; never merge with a check pending or failing.

### 8. Log

Append to `~/satchel-daily/log.md`:

```markdown
## <date> · injection review

- sessions: <n> collected · <n> labelled now · <n> in the golden set · <n> typed prompts scored
- parity: <n> of <n>
- scorecard (production / main / branch): reached · clean · quiet · repeat · topic right · harmful · utility
- second labeller: agrees on every number · or which numbers it does not
- TODOs: added #<n> · done #<n> (<commit>) · carried <n>
- report: injection-review/<date>/report.md
- changes beyond the review: the PR and its merge, or why it did not merge
- watch next: <the number that should move on the next run, and why>
```

Finish with a short message: the scorecard row, the top three gaps, what step 7 built and whether it merged (with the link), what changes for the user, as a small before and now table with one real example, anything waiting on the person (a settings change, a data fix, a blocked merge), and the path to the report. Clean up `$WORK`.

## What the first run found

11 October, 158 sessions, 1,280 typed prompts labelled, 405 host messages. On today's memory set:

| | production | main replay |
| --- | --- | --- |
| reached | 21.5% | 81.3% |
| clean | 12.9% | 19.9% |
| quiet | 86.6% | 69.5% |
| repeat | 54.3% | 60.2% |
| topic right | 34.2% | 39.7% |
| harmful | 8 | 24 |

Production's low reached is mostly history: 152 of the 246 "must" labels (62%) name a memory that did not exist yet when that prompt ran, because the labels are judged against today's memory set. So read production's reached as a lower bound, and compare code on the replay. The replay's low clean and quiet are today's problem.

Those numbers were scored against today's memory set. Since 16 October the replay is as of each prompt (D37): on the same sessions main's replay reached went from 80.9% to 89.0% and quiet from 86.1% to 96.6%, production's reached from 25.0% to 87.7%, and 340 of 1302 labelled prompts were left out because nothing they needed existed yet.

Labellers agreed on the topic 93% of the time and on "this prompt needs nothing" 79%, but on only a third of the exact "must" calls, mostly over weak "helps" on vague prompts. So absolute numbers carry the labeller's taste. Both labellers agreed on which version was better on every number, which is what a gate needs.

A scratch change that skipped the active topic's start-block rows on every prompt took repeat from 60% to 39%, slots down by a third, quiet from 70% to 79%, and utility up 0.065 (outside noise), with reached down under a point. That is the first TODO.
