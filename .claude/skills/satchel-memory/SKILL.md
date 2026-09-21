---
name: satchel-memory
description: How Satchel's memory system works and why it is built this way. Use when changing anything under server/, supabase/migrations/, eval/ or the memory parts of src/, when tuning retrieval or capture quality, when running or reading the eval, when applying migrations or backfilling embeddings, or when a decision about memory needs the measurement behind it. This documents the system for people building it, not for agents using it.
---

# Satchel memory, and why it is shaped this way

This is the working record of Memory v2: what the system does, what was measured, and which decisions were settled by that measurement rather than by argument.

There is a second skill with a similar name. `integrations/shared/context/` is the skill Satchel *ships* to end users, telling their agent how to call the tools. This one is for whoever is building Satchel. If you are editing `server/`, `supabase/migrations/`, `eval/` or the memory parts of `src/`, you want this one.

## The one paragraph version

A memory is one sentence. It is either `said` (the user asked for it) or `heard` (a small model picked it up and the agent must announce it before relying on it). Memories live in exactly one scope: personal, or one project. At session start, every personal memory loads whole. On every prompt, the prompt is embedded and the closest memories above a similarity gate are injected. At the end of a turn, a small model reads a short rolling window and decides whether anything the user said is worth keeping. Every number in that sentence came from an eval over a 473-memory labelled corpus.

## Read this first, then route

| What you are doing | Read |
| --- | --- |
| Changing how retrieval ranks, gates or scopes | `references/decisions.md`, then `references/evaluation.md` |
| Changing the schema, a function, a policy or a constraint | `references/schema.md` |
| Changing hooks, the MCP surface, the service or the router | `references/architecture.md` |
| Running the eval, or re-measuring after a change | `references/evaluation.md` |
| Applying migrations, backfilling embeddings, verifying pgvector, reading traces | `references/operations.md` |
| Anything at all, before you trust a number or a green test | `references/traps.md` |

Do not load a reference you are not about to use.

## The rules that outrank convenience

These are the ones that were paid for. Breaking one is a decision, not a refactor.

**A memory is one sentence, and `source` is what the user typed.** Statements are rewritten for clarity; they are never invented. Every automatically captured memory carries a span from the turn it came from, and the router drops any item whose source is not in that turn. That check is what makes fabrication detectable instead of a matter of trust.

**`said` and `heard` are not cosmetic.** Automatic capture only ever writes `heard`. An agent must say a heard memory out loud before acting on it. Confirming is the only thing that promotes it. Without that line, automatic capture is a system that quietly invents the user's opinions.

**Personal memories load, they are not retrieved.** Measured: on prompts whose only relevant memories are standing writing rules, retrieval scores nDCG 0.174 and loading scores 0.772. Similarity measures topic overlap, and a standing preference is relevant by category of activity instead. This is why personal scope is not a setting.

**Silence is a correct answer.** 45 of the 159 eval prompts have no correct answer, and 13 of those share strong vocabulary with a real memory while meaning something else. The single metric the eval optimises counts silence on those as a win. A system that always returns five rows scores worse than one that often returns none.

**Retrieval degrades to silence, never to noise.** If embedding fails, the save still happens and the row is simply not searchable until the backfill picks it up. Nothing ever stores a zero vector or a partial batch, because a plausible wrong vector is worse than no retrieval.

**The transcript is read at `Stop`, and only there.** This changed in 0.3.0 and used to say the opposite, so it is worth knowing why. While the hooks were `mcp_tool` calls the host substituted `${prompt}` and `${last_assistant_message}` into the arguments. Hooks are command scripts now, because an `mcp_tool` hook cannot run at launch, and a command hook on `UserPromptSubmit` is not handed the prompt at all. `transcript_path` is the only way left to reach it.

The host warns that the transcript lags the in-memory conversation. That is about reading it mid-turn; at `Stop` the turn is over and there is nothing to race. The content that leaves the machine is the same content as before. `integrations/shared/transcript.mjs` is the boundary, and it takes the person's typed messages and the assistant's plain text only: no tool calls, no tool results, no thinking, no subagents, no compaction summaries, no shell or slash commands, no host-injected blocks. The rolling window still lives in the database, trimmed on write and expired after 24 hours, and no conversation is kept beyond it.

**Numbers in migrations are measured, not chosen.** The gate of 0.67, the boost of 1.1 and the cap of 5 each have a measurement behind them in `references/decisions.md`. The gate in particular is per embedding model: the same corpus gives 0.43 for all-minilm and 0.28 for nemotron. Changing the embedding model means re-running `eval/run.mjs` and updating the setting, not guessing.

**Specific is not durable, and the router's job is telling them apart.** The failure that costs the most is not a missed memory, it is a work order stored as a claim. "update the plugin marketplace so installs get 0.2.2" names a version and a component, is plainly about the project, and is stale the moment the work lands. Three of those reached the memory list in one afternoon before the wording was tightened. The turns that caused it are in `eval/router-cases.json`, each naming the Langfuse observation it was copied out of, and `node eval/router-rigour.mjs` is the measurement.

**The capture prompt lives in Langfuse, not in the code.** `server/prompts/capture-router.md` is the editing surface and the fallback; `scripts/push-prompt.mjs` publishes a version and moves the `production` label. Every trace records which version produced it, which is the only way a wording change can be argued about after the fact. Nothing pulls a Langfuse version back over the file.

**Everything proprietary runs on the server.** The hook scripts carry a session key, a repository name and the turn, and nothing else. No key, no prompt, and none of the ranking or routing logic ever lands on the user's machine.

## Where things live

```
server/
  mcp-server.mjs        the tool surface
  lifecycle.mjs         what a session start injects and what the end of a turn captures
  hook-handler.mjs      the two endpoints the plugin's hook scripts call
  agent-token.mjs       bearer verification, kept apart so a cheap endpoint stays cheap
  vector.mjs            indexedText and toVectorLiteral, for the same reason
  memory-service.mjs    the only place that talks to the database
  embedding.mjs         text to vector, provider independent, always L2 normalised
  router.mjs            the end-of-turn capture model: schema, validation, the call
  prompt-store.mjs      resolves the capture wording from Langfuse, falls back to the file
  prompts/              the committed copy of that wording, and the thing you edit
  injection-format.mjs  the exact bytes that reach the model, kept pure
  tracing.mjs           Langfuse, safe to call when unconfigured, never throws into a request
supabase/migrations/    the schema, the functions and every policy
eval/                   the corpus, the labels, the metrics and the baseline
eval/router-cases.json  turns the router got wrong in production, and the ones it must still keep
scripts/                verify-pgvector.mjs, embed-memories.mjs, push-prompt.mjs
```

## When you change something

0. If it changes the capture wording, edit `server/prompts/capture-router.md`, run `node eval/router-rigour.mjs --prompt production --prompt local` to hold the new text against what is live, and only then `node scripts/push-prompt.mjs --push`. Publishing before measuring makes the label the experiment.
1. If it touches ranking, gating, scoping or what gets embedded, re-run `npm run eval`. It compares against `eval/baseline.json` and exits non-zero on a regression worse than 0.02.
2. If it touches the schema, add a migration. Never edit an applied one except to correct a comment, and if you do that, resync the recorded statement so the file and the ledger agree.
3. If it touches the lifecycle path, add to `tests/memory-lifecycle.test.mjs`. That file exists because three bugs that made the whole system inert shipped green past a suite of 141 tests.
4. Read `references/traps.md` before you believe a result.
