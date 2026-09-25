---
name: daily-improvement
description: Review the last consolidation runs against a blind read of the same conversations, find what the pass got, missed and could have done, trace each gap to a file, and write a ranked TODO list. Use for the scheduled daily review, or when asked why consolidation is not learning enough, why project memories are not being made, or what to improve next in the pass.
---

# Daily consolidation review

The pass keeps what it keeps, and nothing tells you what it left behind. This review answers that the only way it can be answered: someone else reads the same conversations without seeing the pass's answer, and the two answers are compared.

It reads production and Langfuse, writes a report to a private folder on this machine, and changes nothing else. It is meant to run unattended, Tuesday to Saturday, after the nightly run.

## Rules

- **Read only.** No database writes, no memory writes (never call `save_memory`, `correct_memory`, `forget_memory` or `confirm_memory`), no code changes, no commits, no pushes. The review produces TODOs; a person decides which get built.
- **No evals.** A consolidation eval costs model quota the nightly run needs. Name the eval case a TODO should add; do not run it.
- **Secrets stay in `~/.config/env`.** The scripts read `SB_TOKEN` and the `LANGFUSE_*` keys from there. Never print them, never paste them.
- **Conversations stay in the folder.** The collected turns are the person's words. The report quotes at most a few words at a time, and the final chat message quotes nothing longer than a short phrase.
- **Do not touch the shared checkout** at `/Volumes/Casesensitive/Github/satchel`: another session may be on another branch there. Read code from `origin/main` (see Setup).

## Setup

The skill lives on `main`. Work from a fresh copy of it so the review reads the code that is actually deployed:

```bash
REPO=/Volumes/Casesensitive/Github/satchel
git -C $REPO fetch -q origin main
WORK=$(mktemp -d)
git -C $REPO archive origin/main | tar -x -C $WORK
SKILL=$WORK/.claude/skills/daily-improvement
```

Read code under `$WORK` from here on. `git -C $REPO log origin/main` is how you check whether a TODO landed.

## Steps

### 1. Collect

```bash
node $SKILL/scripts/collect.mjs
```

It picks up where the last review stopped (`~/satchel-daily/state.json`), or the last 48 hours, and prints the folder it wrote. Call it `F`. It holds:

| Path | What |
| --- | --- |
| `F/window.json` | the window, and how many jobs and runs were in it |
| `F/stats.json` | each job's totals; live memories by scope, kind and band; changes in the window; documents in the window by scope; sessions waiting now |
| `F/langfuse.json` | per run trace: model, thinking, waited, tokens, cost, latency, level and status |
| `F/blind/<name>.md` | what the pass was given: projects, memories in scope then, the new turns in full |
| `F/blind/INDEX.json` | per session turns, characters, turns longer than the consolidator's cut, and the batches |
| `F/pipeline/<name>.md` | what the pass did: what landed, the job's report entry, the Langfuse trace, the raw answer |
| `F/pipeline/<name>.prompt.txt` | the exact prompt the model was sent |

If it says nothing ran, write a three-line report (the window, sessions waiting now from a quick `stats`, and "no run to review"), mark it (step 8) and stop.

### 2. Start the blind reads

For each batch in `F/blind/INDEX.json`, start a background agent with the prompt in [references/blind-read.md](references/blind-read.md): `subagent_type: general-purpose`, `model: sonnet`, all batches in one message. Output goes to `F/blind/out-<n>.json`. The blind readers see `F/blind/` and nothing else; never point them at `pipeline/`, the repository or the database.

### 3. Read the pipeline while they run

Do not open `F/blind/out-*.json` yet. For every session read `F/pipeline/<name>.md`, and the head of `F/pipeline/<name>.prompt.txt` (everything before the turns) to see what the model was told: which scope the session had, which projects and memories it was shown, whether it could have written to a project at all. Read `$WORK/server/prompts/consolidate.md` once, since it is the standard the pass was held to.

### 4. Compare

When every blind agent is back, go session by session and sort every change into:

- **both**: the same claim, action and scope, near enough. Note a scope or kind mismatch.
- **pipeline only**: judge it good, noisy, wrong or stale-prone.
- **blind only**: judge it with the prompt's own definition. A real miss, or blind over-reach (a job, a one-time choice inside a job, the assistant's words, today's state). Blind readers lean generous; about half their extras are usually over-reach. Say which, and why, in a line.

Misses seen in two or more sessions are the strongest evidence. So is the same shape missed repeatedly.

### 5. Answer the gap checklist

Every review answers all of these with numbers, even when the answer is "fine":

1. **Scope.** Changes landed per scope. Sessions the pass saw as personal against project. For every blind change filed under a project: what scope the pass had for that session, and whether its prompt offered that project at all. If project memories are not being made, this is where it shows.
2. **Kinds.** Facts, preferences and intents added, and intents retired, pipeline against blind.
3. **Actions beyond add.** Affirm, extend, replace and retire: used by the pass when the blind read used them?
4. **Shapes it misses.** Group the real misses by shape: a rule inside a job, "do X so I can Y", setup facts, decisions about a project, intents.
5. **What it never saw.** For each real miss, is the evidence in a turn longer than the cut (`cut_user`, `cut_assistant` in INDEX, 2000 and 800 characters)? A miss past the cut is an input problem, not a judgment problem.
6. **Runtime.** From `F/langfuse.json`: models used, thinking level, calls that waited, errors, reasoning tokens against output, cost, the slowest calls.
7. **Failures.** Failed, skipped and rejected changes, with the reasons.
8. **Quality of what landed.** Wrong, vague, too narrow, stale-prone, or a duplicate of an existing memory.

### 6. Find the cause

For each gap, find the place that causes it and cite `file:line` under `$WORK`: a prompt section in `server/prompts/consolidate.md`; how the input is built in `server/consolidator.mjs`; which scope a session gets in `server/consolidation.mjs`, `documents.project_id` and the hooks' repository linking; or the eval coverage in `eval/consolidation-cases.json`. Read the code to confirm it. If you cannot confirm a cause, say it is a guess.

### 7. Write the TODOs

Open the newest earlier `~/satchel-daily/*/report.md`, if there is one, and carry its TODOs forward:

- landed since (check `git -C $REPO log origin/main --since=<that date>`): mark done, with the commit.
- still open and seen again today: raise its `seen` count and add today's evidence.
- still open and not seen today: keep it, unchanged.

Then add new ones. Every TODO has: priority (P1 is what would make the pass learn the most), what to change, the evidence (session ids and a short quote), where (`file:line`), and how to verify it (the eval case to add, or the number in this review that should move). One TODO per cause, not per symptom.

### 8. Report and mark

Write `F/report.md` in the shape in [references/report.md](references/report.md), then record the window as reviewed:

```bash
node $SKILL/scripts/collect.mjs --mark F
```

Finish with a short message: the numbers row, the top three gaps, the P1 TODOs, and the path to the report. Clean up `$WORK`.

## Where this came from

The first blind comparison, on 23 September, read 27 sessions two ways. The pass made 9 changes and the blind read 27. The pass made 8 of its 9 the same way the blind read did, and it missed a preference said in three different sessions ("push first so I can review"). Nothing in the eval or the job report could have shown either fact. This skill is that comparison, made repeatable.
