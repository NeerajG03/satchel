# Every decision, with the measurement that settled it

Source: `docs/memory-v2-build.md` section 4, `eval/baseline.json`, and the live verification run of 2026-09-20. Numbers are on the 473-memory, 159-prompt labelled corpus unless it says otherwise. Intervals are a seeded paired bootstrap, 2000 resamples, 95%.

## The metric everything is judged on

`utility` = nDCG@10 on the 114 answerable prompts, and 1 or 0 for staying silent on the 45 answerless ones, averaged over all 159.

This exists because nDCG alone rewards always answering. A system that returns five rows for "what is the capital of France" scores the same as one that correctly says nothing. Since 45 of 159 prompts have no answer, and 13 of those are deliberate lexical traps, silence had to be in the objective or the eval would have selected the wrong system.

## Vectors over lexical: real, and the only difference that was

Plain SQL was measured first, before reaching for an extension.

| system | utility | nDCG@10 |
|---|---|---|
| lexical, IDF sum | 0.316 [0.265, 0.365] | 0.440 |
| vector all-minilm | 0.389 [0.336, 0.442] | 0.543 |
| vector nomic, statement+source | 0.396 [0.341, 0.449] | 0.552 |
| hybrid 0.3 lexical + minilm | 0.400 [0.345, 0.453] | 0.558 |

Vectors beat lexical by +0.108 [0.057, 0.159]. Hybrid over pure vector, and one embedding model over another, were both inside the noise on the first corpus. So there is no fusion, no IDF function, no `lexeme_df` view and no second ranker to keep in sync. One vector index and one score.

Two facts that killed the lexical path outright:

- `websearch_to_tsquery` ANDs its terms, so it returned nothing for 71 of 75 prompts. A 5% hit rate that fails silently.
- A plain exact cosine scan in SQL took 117ms at 500 rows per owner and 462ms at 2000. That is what made pgvector necessary rather than optional.

## Gating is worth more than everything else combined

| system | utility | covered | silent |
|---|---|---|---|
| vector nomic s+s, no gate | 0.396 | 114/114 | 0/45 |
| nomic s+s + boost + gate | 0.588 [0.532, 0.644] | 99/114 | 38/45 |
| gemini-768 s+s + boost + gate | **0.640** | 101/114 | 39/45 |

Adding a gate is worth about 0.19 utility, which is larger than every other difference in the whole investigation put together.

This was nearly missed. On the first corpus only **six** prompts were answerless, and on six samples gating looked like a wash. Growing the answerless set from 6 to 45 is what revealed it.

## The gate is per model, and must be recalibrated

Calibrated from the labels by `eval/run.mjs`, never taken as a literal:

```
gemini-embedding-001 @ 768, statement+source   0.67   <- production
nomic-embed-text, statement+source             0.62
nomic-embed-text, statement                    0.61
all-minilm, statement                          0.43
nemotron-2048, statement+source                0.30
nemotron-768, statement+source                 0.28
nemotron3-2048, statement+source               0.24
```

A shared constant would be wrong by 0.4 cosine across that range. Applying nomic's threshold to all-minilm collapsed coverage from 67 to 22 of 69 prompts. **Changing the embedding model means re-running the eval and updating `memory_settings.gate`.**

## Scope is a boost of 1.1, not 3.0

A boost multiplies a score in [0,1], so a large one reorders globally instead of nudging. Measured with the boosted project being the right one, and being the wrong one:

| multiplier | right project | wrong project | break-even hit rate |
|---|---|---|---|
| 1.05 | +0.048 | −0.010 | 18% |
| **1.1** | **+0.077** | **−0.022** | **22%** |
| 1.25 | +0.080 | −0.116 | 59% |
| 2.0 | +0.073 | −0.493 | 87% |
| 3.0 | +0.073 | −0.508 | 87% |

1.1 captures the entire benefit of 3.0 and costs a twentieth as much when wrong. Above 1.25 the gain is flat and only the damage grows. The original design specified 3.0, which would have needed 87% of a session's prompts to be about that one project just to break even.

Scope is a boost and not a filter, so a first mention of an unrelated project still wins on similarity alone.

## The closed-task demotion was wrong, and the labels said so

```
memories hanging off a closed task: 8.5% of the corpus, 11.4% of what the labels call relevant
```

They are *more* likely to be wanted, not less. A task closing does not make what you learned during it irrelevant. The proposed 0.7 demotion is gone. The `[task · closed, may be fixed]` annotation stays, because flagging possible staleness is a different thing from ranking lower.

## What gets embedded: statement plus source

On the first corpus this was called noise. On 159 prompts it is a real **+0.043**. The extra text is the user's own phrasing, which is closer to how they later ask for it.

Prefixing the project name actively hurts: 0.508 against 0.523 for plain statement.

`source` is stored for provenance and indexed, and is **never injected**.

## Personal memories load whole, and that is not a setting

The worst slice in the eval is the one the design predicted:

```
style-only prompts (n=6), where the only relevant memories are standing writing rules
  retrieval alone                        nDCG 0.174
  with personal memories already loaded  nDCG 0.772
```

4.4x. Similarity measures topic overlap, and a standing preference is relevant by category of activity. The rules a user cares about most are the ones retrieval is worst at.

## Gemini over everything local, measured

Gemini was the first hosted model to beat the local baseline: **+0.052 utility [0.012, 0.092]**.

`gemini-embedding-001` honours a `dimensions` request, so 768 fits the indexed column. That matters more than it looks: pgvector indexes `vector` up to 2000 dimensions and `halfvec` up to 4000, and several current models return 2048. A model that cannot truncate needs halfvec and 2.7x the storage.

At 768 it returns an un-normalised vector. Everything is L2 normalised in `embedding.mjs` regardless, so cosine and dot product agree and a stored vector always means the same as a query vector.

## Where retrieval is still weak

| slice | n | nDCG@10 | covered | silent |
|---|---|---|---|---|
| temporal | 3 | 0.940 | 3/3 | |
| code-mixed (Hinglish) | 5 | 0.811 | 5/5 | |
| typo | 5 | 0.759 | 5/5 | |
| identifier | 5 | 0.757 | 5/5 | |
| rambling | 4 | 0.679 | 4/4 | |
| paraphrase | 9 | 0.467 | 8/9 | |
| cross-domain | 3 | 0.410 | 3/3 | |
| style-only | 6 | 0.174 | 5/6 | |
| fresh-topic | 8 | 0.000 | 0/4 | 4/4 |
| lexical-trap | 13 | 0.000 | 0/1 | 10/12 |

Typos, Hinglish and identifier lookups are handled far better than expected from an embedding model. Paraphrase, the case vectors exist for, sits mid-table. Two leaks remain and are honest failures: 2 of 12 lexical traps and 3 of 8 uncovered prompts get an answer they should not.

## The router

One small model call at the end of a turn. It is not an agent: no tools, no memory of its own, and no access to what is already stored. It sees a rolling window and returns a list, and an empty list is the answer on most turns.

`gemini-3.5-flash-lite`, pinned and not `-latest`, because the instructions were tuned against this version and a floating alias would move the thing the measurement describes.

Measured over 24 real turns replayed from the corpus plus 16 that contain nothing durable:

```
before prompt guardrails   17/24 extracted (71%), 16/16 quiet
after                      22/24 extracted (92%), 16/16 quiet, about 1.6s
```

The whole 21 point gain came from the prompt: worked examples, an explicit list of what not to keep, and the rule that splitting only happens when the parts already stand alone.

### Naming the scope instead of asking the model to infer it

The router used to get a flat list of every project and nothing saying which one the conversation was in, so it inferred the scope from the words. A memory about Satchel's own deployment key said "vercel" and not "satchel", so it landed in personal.

The workspace's git remote already resolves to a project through `project_repositories`, so the prompt names it. That was measured as an A/B on the same sample through the same code, with `ROUTER_EVAL_NO_SCOPE=1` withholding the scope and handing over the flat list the way the router used to get it:

```
                       scope withheld     scope named
extracted a memory     32/40   80%        32/40   80%
statement overlap      0.27               0.28
scope, in a project    10/14   71%        14/14  100%
scope, universal       17/18   94%        17/18   94%
stayed quiet           16/16  100%        16/16  100%
```

One row moves and nothing else does. All four discordant items went the improving way, so a one-sided sign test puts it at about p = 0.06: suggestive at fourteen samples, not conclusive, and the mechanism is not in doubt because the model had no way to know the project. Raise `SCOPED` in `eval/router.mjs` if the number needs to be solid.

The other two rows are the ones that could have gone wrong and did not. **Universal preferences did not get swallowed** into whichever project was open, which is the regression defaulting to a project invites: 17/18 both times, and the same single item in both runs. It files "the passport renewal has to be done before March 2028" into `schengen-visa`, which the corpus labels personal and which is arguably the label being wrong rather than the model. **And naming an open project did not make the router start finding things in it**: 16/16 quiet both ways.

The eval scored the project slug only on memories that have one, which is the direction this change cannot get wrong. Personal memories are 19% of the corpus, so a proportional sample gave four or five out of 24, which cannot measure a threshold. They are sampled deliberately now and counted separately, replayed from inside a rotating project so no one project's brief can explain the result.

Everything the model returns is validated before it reaches the database. An item is dropped if its statement is missing or over 500 characters, if it has no source, or if its source is not in the turn being classified. A project slug not in the supplied list becomes personal, which is the safer mistake. A task drags its own project.

## A work order is not a memory, and the prompt is where that is decided

On 21 September 2026 the memory list filled with things that were not memories: "Update the plugin marketplace so installs get 0.2.2", "Link data-model-2-0 to cbx1/backend", "fix the repository-hint import so cold start drops". Each one is the user's own words, each is plainly about the open project, each is specific, and each is stale the moment the work lands. Langfuse has all three, with the turn that produced them.

Worse, one of them was a belief the user was arguing against. "One codebase can only be connected to one project this is the wrong way to look at it" was stored as its first eight words.

`eval/router.mjs` could not have caught either. Every turn it replays comes from a memory, so it can only measure whether a real claim survives; it has nothing to say about a turn that should produce nothing. So `eval/router-cases.json` was built out of the traces themselves, 24 scored cases, each failing one copied from the observation it came from.

Same cases, same model, same code path, two wordings:

| | stayed quiet | kept the claim | both |
|---|---|---|---|
| prompt v1, what production ran | 9/15  60% | 5/9  56% | 14/24  58% |
| prompt v2 | 15/15  100% | 6/9  67% | 21/24  88% |

Work orders went 3/8 to 8/8, the rejected premise from stored to silent, and the correction case from keeping the premise to keeping only the correction. Nothing that should be kept was lost to it.

What did the work, in order of how much:

- Naming the failure instead of describing its opposite. The old wording said not to keep "a one-off instruction for this task alone: make it shorter, try again". Every example was trivial, so a model reading it generalised to trivial instructions. The new wording says a work order is not a claim however precise it is, and that specific is not the same as durable.
- A syntactic tell the model can actually apply: if the statement you are about to write is the user's sentence with the grammar tidied and it starts with a verb, drop it.
- An instruction to read the whole turn before keeping part of it, because people quote a thing in order to reject it.

A tighter prompt can buy silence by making the router timid, so `eval/router.mjs` was run on both wordings as the control, 40 positives and 16 negatives:

| | extracted | scope in a project | scope universal | stayed quiet | median |
|---|---|---|---|---|---|
| v1 | 32/40  80% | 15/15 | 16/17  94% | 15/16  94% | 1522ms |
| v2 | 31/40  78% | 15/15 | 15/16  94% | 16/16  100% | 1584ms |

One extraction apart on 40 samples, and v1 lost one call to a timeout so the denominators are not even the same run. Scope is unchanged. So the rigour gain did not come out of extraction.

It is not free: the wording went from 3403 to 6387 characters, about 750 more input tokens on every capture, roughly $0.0002 a turn at the flash-lite input price, and 60ms on the median. That is the price of the 6 cases, and it is worth paying.

The three cases still wrong are all the same one, and it is not this: a universal rule filed into the open project rather than personal. That is the known cost of defaulting to the working project, measured separately in `eval/router.mjs`, and this change neither helped nor hurt it.

The prompt now lives in Langfuse as `satchel-capture-router` with `server/prompts/capture-router.md` as the editing surface and the fallback. Not for convenience: a wording change can only be argued about afterwards if the traces from before and after can be told apart, and v1 is published under the `baseline` label for exactly that reason.

## pgvector, verified against the live database

```
5000 rows, 159 real queries, ef_search 40 (default)
recall@5 against an exact scan   98.7%
identical top 5                  154/159
HNSW mean                        0.85 ms
exact scan mean                  28.23 ms
```

So the eval measured an exact scan, the index approximates it closely enough, and the eval's numbers transfer. Getting that number honestly took two corrections, both in `references/traps.md`.

## Decisions taken without a measurement

Recorded as judgement, not as evidence:

- Six-character handles for memories in injected text. Short enough for a model to copy without transposing, long enough to name a row.
- Slugs supplied on create, not derived from the title. A 40-character slug derived from a sentence is something nobody would say, and a model matches it worse than the title. The derived form exists only so no row can lack one.
- Slugs unique per user across projects and tasks together, so there is one thing to get right instead of two.
- A session-start block withheld entirely when it exceeds the token budget, rather than truncated. A partial block that looks complete is worse than an honest absence, because the agent cannot tell.
- No fixed instruction preamble in injected context. The headers carry the instructions instead, because a fixed paragraph was measured at 58% of a competitor's per-prompt cost, and a header sits beside the rows it governs and cannot be skipped.
