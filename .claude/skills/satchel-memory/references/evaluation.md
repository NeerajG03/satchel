# The eval, and how to trust a number from it

```bash
node eval/embed.mjs     # cache embeddings for an index; incremental, id keyed
npm run eval            # the report, compared against the committed baseline
node eval/run.mjs --slices           # per-category breakdown, where you see what moved
node eval/run.mjs --update-baseline  # adopt the current numbers, only after reading them
node eval/router.mjs    # the capture model, replayed over real turns
```

`run.mjs` exits non-zero when a system regresses more than 0.02 utility against `eval/baseline.json`, so it gates a change.

## The corpus

473 memories, 159 prompts (114 answerable, 45 answerless), 99 tasks, 17 projects. 373 grade-2 and 537 grade-1 judgements.

One invented person: a Bengaluru software engineer with work codebases, side projects, tax admin, running, knee rehab, sourdough, film photography, a flat move, a Schengen visa, a wedding and a Goa trip. Nothing in it is real.

It was written by agents given the schema and a quality bar and **no knowledge of the retrieval design**. That matters. A corpus written alongside the query is a corpus that agrees with the query.

The edge cases were added deliberately against the set's own weak spots: `supersession` (a newer memory contradicting an older one), `near-duplicate` (the same fact for a different project, so fetching the wrong one is a real error), `identifier`, `very-short`, `numeric`, `people`, `task-dependent`, `half-opinion`.

The prompt categories: `paraphrase`, `identifier`, `code-mixed` (Hinglish), `typo`, `rambling`, `style-only`, `cross-domain`, `temporal`, and the answerless ones, `fresh-topic`, `continuation`, `uncovered` and 13 `lexical-trap` prompts that share strong vocabulary with a real memory while meaning something unrelated.

## The metric

```
utility = mean over all 159 prompts of:
    nDCG@10                    if the prompt has an answer
    1 if silent, else 0        if it does not
```

Two systems cannot be compared on relevance alone, because a system that stays quiet more often scores worse on every relevance metric while being better to use. The number is only as honest as the answerable-to-answerless ratio, which is why the report prints that ratio next to it.

nDCG, R@5 and MRR say how good the answers are. Coverage and silence say how often it speaks when it should and stays quiet when it should. All of them are still reported.

## Significance

Every interval is a **seeded** bootstrap over prompts, 2000 resamples, 95%. Comparisons are **paired**, so they test the change rather than the variation between prompts.

A difference whose interval includes zero is printed as `noise` and should be treated as no difference. Reporting three decimals does not make a difference real. On this corpus most differences between vector configurations are noise.

Because the seed is fixed, two runs of the same code print the same numbers, and a diff means something changed.

## The gate is calibrated, not configured

`run.mjs` derives the gate per index by maximising utility on the labels. It is never taken as a literal, because it moves by up to 0.4 cosine between embedding models. Adding a model to `embed.mjs` is enough to put it in the comparison with its own calibrated gate.

## Adding to the corpus

**Re-check the existing labels.** Adding 60 memories meant 14 older prompts had gained a correct answer they were not credited for. `eval/lib/data.mjs` refuses to run if any prompt is unlabelled, because an unlabelled prompt silently counts as answerless and quietly corrupts the floor.

`eval/merge.mjs` and `eval/merge-labels.mjs` are for folding in agent-generated additions.

## The router eval

`eval/router.mjs` replays real turns from the corpus. Negatives are drawn only from `continuation`, `general-knowledge` and `lexical-trap`, because retrieval-answerless prompts are not capture-answerless: punishing the router for correctly capturing a real intent that simply has no stored answer measures the wrong thing.

It reports extraction rate, mean word overlap with the real statement, project slug accuracy, quiet rate on turns with nothing to keep, and median latency. Errors are surfaced with their reason, because a 429 swallowed as a failure once made the model look far worse than it was.

## The capture rigour eval

`eval/router-rigour.mjs` over `eval/router-cases.json`: real turns copied out of Langfuse after the router stored something it should not have, each naming its observation under `from`. It reports staying quiet and keeping the claim as two numbers, because each is trivially won alone.

## The consolidation eval

`eval/consolidation.mjs` over `eval/consolidation-cases.json`, 26 cases. Neither capture eval can measure the pass, because the router has one output and the pass has five, four of which name a memory that already exists. So **every case carries its own memory set**: the same sentence is a retire next to an intent, a no-op next to a fact, and an extend next to a narrower version of itself.

Three numbers, read together:

```
left it alone      cases where nothing should change     trivially won by doing nothing
changed it right   the change the case named, on the memory it named
ended wrongly      retires and replaces nobody asked for  the bar is zero
```

The third is not averaged into anything. One is a regression and the run exits non-zero; overall accuracy gets 8 points of slack before it gates, because a model call is not deterministic and a bench people rerun until it passes is not a bench. Damage counts on `either` cases too.

Two rules the harness keeps. **The model is pinned and the fallback is off**, because `createConsolidator` switches models under load and a run split across two models describes neither. **The date is fixed** at 22 September 2026, so the temporal case scores the same in March and in December.

Scoring is pure, in `eval/lib/consolidation-scoring.mjs`, and `tests/consolidation-eval.test.mjs` checks it without a model, including that the case file is internally consistent: a case that targets a memory it does not carry can never pass and would drag the number down forever. Which side of the trade a case is on is read off its expectation (`isRestraint`), not kept as a list of categories, because `churn` legitimately sits on both.

```bash
node eval/consolidation.mjs                                   # the local prompt
node eval/consolidation.mjs --prompt production --prompt local
node eval/consolidation.mjs --only retire --repeat 3
node eval/consolidation.mjs --update-baseline                 # only on the shipped model
```

There is no committed consolidation baseline yet. The only full run was on `gemini-3.5-flash-lite` with thinking off, because a free key allows 20 calls a day per model and a run is 26, so it is recorded in `decisions.md` as a floor. The baseline needs a paid key.

## Files

```
eval/corpus.json      memories, prompts, tasks, projects, with stable ids (m0000, p000)
eval/labels.json      grade-2 and grade-1 judgements, keyed by prompt id
eval/baseline.json    the committed numbers every run is compared against
eval/embeddings/      one cache per index, id keyed and incremental
eval/lib/data.mjs     loading, and validate() which refuses to run on unlabelled prompts
eval/lib/metrics.mjs  ndcg, recallAt, precisionAt, reciprocalRank, ci(), paired(), utility()
eval/lib/rankers.mjs  lexicalRanker (PGlite IDF), vectorRankers, hybrid, boost, gate, cap
eval/router-cases.json         capture turns, most copied out of Langfuse
eval/consolidation-cases.json  memory set + conversation + expected change, per case
eval/lib/consolidation-scoring.mjs  contains, damage, score, isRestraint, summarise
```

## The current baseline

```
primary   gemini-768/statement+source +gate
gate 0.67   boost 1.1   cap 5
utility 0.640   covered 101/114   silent 39/45
```

Full comparison in `decisions.md`.

## What the eval cannot tell you

It measures ranking against an exact cosine scan. It says nothing about:

- whether the HNSW index agrees with that exact scan. That is `scripts/verify-pgvector.mjs`, measured at 98.7% recall@5, and the two ways it produced a confident wrong answer are in `traps.md`.
- whether the service layer passes the right arguments to the database. Three bugs there made retrieval and capture completely inert while the eval was green. `tests/memory-lifecycle.test.mjs` covers that gap.
- whether anything is configured to call the code at all. The whole capture path once shipped with no `Stop` hook, and the consolidation pass had never written a row in production when it was first tested end to end.
- whether the pass's changes actually apply. The eval scores what the model decided; `tests/consolidation.test.mjs` covers what the database does with it.
