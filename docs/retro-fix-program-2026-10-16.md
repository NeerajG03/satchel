# Retro fix program · 16 October 2026

What the retro and the five scenarios found, turned into one build program. Three design agents wrote the detailed designs; this page is the decisions, the order and the proof for each piece. Plain words, no timeline.

## The one picture

```
 wave 1 (parallel)            wave 2 (one builder, in order)         wave 3
 ─────────────────            ──────────────────────────────         ──────
 R  honest replay      ──►    I-a  labels: said N times, draft age   G  plugin 0.5.3:
 P  pass sees age      ──►    I-b  rules union for many-topic repos     skill sentences,
 S  said-again count          I-c  no-link floor (ships only if          hooks doc, program doc
                                   the replay allows)
 each PR: tests, build, review at high, merge on green, decision row
```

## Decisions taken here

| # | Decision | Why |
|---|---|---|
| 1 | No migration for age. A second indexed select `ages(ids)` returns `created_at` and `mentions` for the few rows a block shows | All four SQL functions lack `created_at`; recreating them means four drops, twelve grants and a hand step before deploy. The select is one primary-key read inside a 1.5 s bound |
| 2 | Label shape. The row's parentheses carry scope, `picked up`, `said N times`. A young unconfirmed topic row gets its own marker line under the row, like the commits marker | The parentheses stay short and scannable. The draft needs a sentence that tells the agent what to do, and the agent already reads the commits line in that spot |
| 3 | Draft = topic row, heard, mentions 1, under 7 days, any kind. Shown, never hidden | Owner's call from the retro: hiding would remove the current decision during a sprint |
| 4 | The replay serves memories as of each prompt and charges block rows, before any injection change is proved | Today's replay credits a change for rows that did not exist yet (127 of 133 in one repo) |
| 5 | Rules union: when a repo names several topics, their preferences load as one block, 15 at most, labelled by topic; facts wait for a pick | Rules are what scope loses; facts are already reached by search. Topic picking by a model is not built |
| 6 | No-link floor ships only if the no-link bucket's reached falls 2 points or less and harmful falls | It is one line of code and the replay is free, so the number decides |
| 7 | One plugin bump to 0.5.3 at the end, carrying every shipped-skill sentence | Three PRs each bumping the plugin would conflict on generated files |
| 8 | Not now: same-day refresh of the pass, an event row per affirm, prompt wording changes | Each is a bigger change than one topic's evidence justifies; revisit with the counts |

Decision ledger rows, pre-assigned so parallel PRs do not collide: D37 replay, D38 pass sees age, D39 labels, D40 rules union, D41 floor (or "not shipped" with the number), D42 said-again count.

## Each piece, and its proof

| Piece | Files | Proof | Design |
|---|---|---|---|
| R honest replay | `eval/injection-real.mjs`, `eval/lib/injection-twin.mjs`, `eval/lib/injection-scoring.mjs`, `tests/injection-eval.test.mjs` | Old and new scorecards on the same `main`; replay reached about 82% to about 89%, quiet about 87% to about 96% | `design-rules.md`, PR 1 |
| P pass sees age | `server/memory-service.mjs` (`ages`), `server/consolidation.mjs`, `server/consolidator.mjs` (`made on`), tests | Unit test on the prompt line; no eval needed, no wording change | `design-age.md` sections 1, 2 |
| S said-again count | `.claude/skills/daily-improvement/scripts/said-again.mjs`, a fixture test, report and log shape, skill step | Fixture test; one dry run on the last window | `design-following.md` fix 1b |
| I-a labels | `server/injection-format.mjs`, `server/lifecycle.mjs`, twin `ages` and `now`, tests | **Shipped, PR 53 merged.** Each row carries `(said N times)` from two on, and a young unconfirmed topic row gets the draft line underneath. No row set changed, so reached, harmful and utility held on the replay; the median prompt block grew by a few tokens a labelled row. D39 | `design-age.md`, `design-following.md` fix 1a |
| I-b rules union | `server/lifecycle.mjs`, `server/injection-format.mjs`, tests | **Not shipped.** Built and measured on the as-of replay: reached in the several-topics row 89.1% to 89.1%, charged utility 0.733 to 0.732, 53 more block rows charged. As of those prompts only 6 rules existed across the four topics, all heard once, and search already reached them. The branch `neeraj/rules-union` is kept for when those topics hold confirmed rules | `design-rules.md`, PR 2 |
| I-c no-link floor | `server/lifecycle.mjs` one line, tests | **Shipped, PR 54 merged.** The bucket rule in decision 6 held: the no-link row reached 100% before and after, so nothing fell; harmful 3 to 2, utility 0.733 to 0.737, quiet in that row 97.6% to 100%. D41 | `design-following.md` fix 2b |
| G plugin 0.5.3 | `integrations/shared/context/SKILL.md` and `references/memory.md`, generated packages, `docs/memory-hooks.md`, this page | **Shipped, PR 55.** `claude plugin validate .` passed. The skill now says a retrieved row is context to weigh against the message, and the memory reference says how to read a count and a draft line. No sentence about several topics loading rules, since I-b did not ship. Also fixed on the way: the paired delta on the double-labelled prompts printed `NaN` when one labeller had not scored a prompt | all three |

## What is left for the owner after this

- Narrow two trap rows in the app (the observability rule and the send-timing fact). Data, ten minutes.
- Watch the no-link bucket. After the floor, its 183 labelled prompts get no prompt block at all, because no topic row reached 0.75 there. That is the quiet the rule asked for, and every prompt that needed something still had it in front of the agent, but a workspace that leaned on a loosely matching topic row would feel it as a miss. The number to read on the next review is reached in that row.
- Forget the self-description rows in the Satchel topic, or leave them.
- Decide, after two weeks of counts: the same-day refresh, and whether an affirm should write an event row.
- Review cadence.
