---
name: satchel-memory
description: How Satchel's memory system works and why it is built this way. Use when changing anything under server/, supabase/migrations/, eval/ or the memory parts of src/, when tuning retrieval or capture quality, when running or reading the eval, when applying migrations or backfilling embeddings, or when a decision about memory needs the measurement behind it. This documents the system for people building it, not for agents using it.
---

# Satchel memory, and why it is shaped this way

This is the working record of Memory v2 and v2.5: what the system does, what was measured, and which decisions were settled by that measurement rather than by argument. The v2.5 requirements, R1 to R11, are in `docs/memory-v2-5-scope.md`, and each one names the commit that built it.

There is a second skill with a similar name. `integrations/shared/context/` is the skill Satchel *ships* to end users, telling their agent how to call the tools. This one is for whoever is building Satchel. If you are editing `server/`, `supabase/migrations/`, `eval/` or the memory parts of `src/`, you want this one.

## The one paragraph version

A memory is one sentence. It is either `said` (the user asked for it) or `heard` (a model picked it up and the agent must announce it before relying on it). It is a `fact`, a `preference` or an `intent`, and it lives in exactly one scope: personal, or one project. At session start, confirmed personal memories load whole, ranked and capped at `block_size`, and unconfirmed ones are counted rather than injected. On every prompt, the prompt is embedded and the closest memories above a similarity gate are injected. Both hooks also write the turn into a **document**, the durable record of the conversation, kept 30 days. Later, and only when something asks, the **consolidation pass** reads a finished document next to the memories already in scope and changes the set: add, extend, replace, retire, affirm, or nothing. A memory is never deleted by the system, it is ended with a reason and can be restored. The retrieval numbers came from an eval over a 473-memory labelled corpus; the consolidation numbers from `eval/consolidation-cases.json`.

## Read this first, then route

| What you are doing | Read |
| --- | --- |
| Changing how retrieval ranks, gates or scopes | `references/decisions.md`, then `references/evaluation.md` |
| Changing the schema, a function, a policy or a constraint | `references/schema.md` |
| Changing hooks, the MCP surface, the service, the router or the consolidation pass | `references/architecture.md` |
| Changing what the consolidation pass decides, or its prompt | `references/decisions.md` "The consolidation pass", then `eval/README.md` |
| Running the eval, or re-measuring after a change | `references/evaluation.md` |
| Applying migrations, backfilling embeddings, verifying pgvector, reading traces | `references/operations.md` |
| Anything at all, before you trust a number or a green test | `references/traps.md` |

Do not load a reference you are not about to use.

## The rules that outrank convenience

These are the ones that were paid for. Breaking one is a decision, not a refactor.

**A memory is one sentence, and `source` is what the user typed.** Statements are rewritten for clarity; they are never invented. Every automatically captured memory carries a span from the turn it came from, and both the router and the consolidation pass drop any item whose source is not in the user's words. That includes a retire: "it is done" is a claim the user has to have made. That check is what makes fabrication detectable instead of a matter of trust.

**`said` and `heard` are not cosmetic.** Automatic capture only ever writes `heard`. A heard memory is never injected at session start, only counted; it can still be retrieved, and an agent must say it out loud before acting on it. Confirming is the only thing that promotes it. Without that, automatic capture is a system that quietly invents the user's opinions and then loads them into every session forever.

**There is one automatic writer, and it is the consolidation pass.** `memory_settings.capture_mode` defaults to `session`, and every existing row was moved to it in `20260922210000`. In `session` mode the Stop hook records the reply and the commit count and writes no memory. The old per-turn router still exists behind `capture_mode = 'turn'`, but the two must never run together: two writers over the same turns save the same claim in two wordings, which production did on 22 September. Nothing runs the pass on its own for a product user yet. It runs when the developer cron or the "Consolidate now" button asks.

**The pass changes the set, it does not insert.** It is shown the new turns of one document and every live memory in scope, relabelled as integers so it can never invent an id. Each thing it decides is `add`, `extend #n`, `replace #n`, `retire #n`, `affirm #n`, or nothing, and nothing is the usual answer. The kinds are load bearing here: a completion ("done, entries are append only now") may retire an `intent` and must never retire a `fact`. `eval/consolidation.mjs` measures exactly this, and its third number, memories ended that should not have been, has a bar of zero.

**A memory ends, it is not deleted.** `ended_at` and `ended_reason` (`replaced`, `retired`, `forgotten`) take it out of use, `archived_memories()` shows it, and `restore_memory` brings it back. Every change is a `memory_events` row written by a trigger, carrying who did it and the trace id, so no writer can skip it. The one real delete is meant to be a person's, from the archive in the web app. Auto-applied consolidation is only acceptable because of this, so a new write path that deletes is a design change and not a shortcut. An agent's `forget_memory` ends the row as `forgotten` through `end_memory`, exactly like the web app's Forget.

**Personal memories load, they are not retrieved.** Measured: on prompts whose only relevant memories are standing writing rules, retrieval scores nDCG 0.174 and loading scores 0.772. Similarity measures topic overlap, and a standing preference is relevant by category of activity instead. This is why personal scope is not a setting.

**Silence is a correct answer.** 45 of the 159 eval prompts have no correct answer, and 13 of those share strong vocabulary with a real memory while meaning something else. The single metric the eval optimises counts silence on those as a win. A system that always returns five rows scores worse than one that often returns none.

**Retrieval degrades to silence, never to noise.** If embedding fails, the save still happens and the row is simply not searchable until the backfill picks it up. Nothing ever stores a zero vector or a partial batch, because a plausible wrong vector is worse than no retrieval.

**The transcript is never read from disk.** Both halves of a turn arrive in the hook input: the host passes `prompt` to `UserPromptSubmit` and `last_assistant_message` to `Stop`, on command hooks as well as `mcp_tool` ones. Both halves are written server side through one `record_turn`: into the short `session_messages` window, trimmed on write and expired after 24 hours, and into the turn's **document**, which is kept 30 days so a better prompt can re-read a past conversation. `expire_documents()` is a real delete with a row count, not a policy sentence. No transcript file is parsed on either host, and nothing past 30 days is kept.

This was briefly untrue. In 0.3.0 capture read the transcript, on the belief that a command hook is not given the prompt and so could not record the user's side. The belief came from a docs summary that hedged, and the binary says otherwise: the host builds the input as `{…, hook_event_name:"UserPromptSubmit", prompt, session_title}`. 0.3.2 put retrieval back as a script and deleted the reader. Check the binary before believing a docs summary about hook inputs.

**Numbers in migrations are measured, not chosen.** The gate of 0.67, the boost of 1.1 and the cap of 5 each have a measurement behind them in `references/decisions.md`. The gate in particular is per embedding model: the same corpus gives 0.43 for all-minilm and 0.28 for nemotron. Changing the embedding model means re-running `eval/run.mjs` and updating the setting, not guessing.

**Specific is not durable, and the writer's job is telling them apart.** The failure that costs the most is not a missed memory, it is a work order stored as a claim. "update the plugin marketplace so installs get 0.2.2" names a version and a component, is plainly about the project, and is stale the moment the work lands. Three of those reached the memory list in one afternoon before the wording was tightened. The turns that caused it are in `eval/router-cases.json`, each naming the Langfuse observation it was copied out of, and `node eval/router-rigour.mjs` is the measurement. The same failures are carried into `eval/consolidation-cases.json` as `work-order`, `situation`, `question` and `rejected-premise`, because they are still failures when the pass is the writer.

**Both prompts live in Langfuse, not in the code.** `satchel-capture-router` and `satchel-consolidate`. `server/prompts/capture-router.md` and `server/prompts/consolidate.md` are the editing surface and the fallback; `scripts/push-prompt.mjs` publishes a version and moves the `production` label (`--prompt satchel-consolidate` for the second one). Every trace records which version produced it, which is the only way a wording change can be argued about after the fact. Nothing pulls a Langfuse version back over the file.

**Everything proprietary runs on the server.** The hook scripts carry a session key, a repository name and the turn, and nothing else. No key, no prompt, and none of the ranking or routing logic ever lands on the user's machine.

## Where things live

```
server/
  mcp-server.mjs        the tool surface
  lifecycle.mjs         what a session start injects, what a prompt retrieves, what a Stop records
  hook-handler.mjs      the endpoints the hook scripts call, plus /api/consolidate
  agent-token.mjs       bearer verification, refresh exchange, the companion check
  vector.mjs            indexedText and toVectorLiteral, kept apart so a cheap endpoint stays cheap
  memory-service.mjs    the only place that talks to the database
  embedding.mjs         text to vector, provider independent, always L2 normalised
  router.mjs            the per-turn capture model, only used when capture_mode = 'turn'
  consolidator.mjs      the consolidation model call: prompt, schema, validation, fallback
  consolidation.mjs     applies what it decided, one document at a time, inside a time budget
  model-provider.mjs    which SDK a model id goes through, fallbackModel, worthAnotherModel
  prompt-store.mjs      resolves both prompts from Langfuse, falls back to the file
  prompts/              capture-router.md and consolidate.md, the things you edit
  injection-format.mjs  the exact bytes that reach the model, kept pure
  tracing.mjs           Langfuse, safe to call when unconfigured, never throws into a request
api/consolidate.mjs     the background pass as an endpoint; nothing in a hook calls it
supabase/migrations/    the schema, the functions and every policy
eval/                   the corpus, the labels, the metrics and the baselines
eval/router-cases.json  turns the router got wrong in production, and the ones it must still keep
eval/consolidation-cases.json  memory sets and conversations, each with the change it should cause
scripts/                verify-pgvector.mjs, embed-memories.mjs, push-prompt.mjs, enable-consolidation.mjs
src/features/activity/  the developer feed and the "Consolidate now" button
src/features/memories/  the book, the archive, forget and restore
```

## When you change something

1. If it changes the capture wording, edit `server/prompts/capture-router.md`, run `node eval/router-rigour.mjs --prompt production --prompt local` to hold the new text against what is live, and only then `node scripts/push-prompt.mjs --push`. Publishing before measuring makes the label the experiment.
2. If it changes the consolidation wording, edit `server/prompts/consolidate.md` and run `node eval/consolidation.mjs --prompt production --prompt local` before `node scripts/push-prompt.mjs --prompt satchel-consolidate --push`. A full run is 26 model calls, and a free Gemini key allows 20 a day on the newest models, so measure on a paid key or the numbers describe the wrong model.
3. If it touches ranking, gating, scoping or what gets embedded, re-run `npm run eval`. It compares against `eval/baseline.json` and exits non-zero on a regression worse than 0.02.
4. If it touches the schema, add a migration. Never edit an applied one except to correct a comment, and if you do that, resync the recorded statement so the file and the ledger agree. **Apply it to production before you push code that reads it.** Vercel deploys `main` the moment it lands and migrations are applied by hand, so the other order means deployed code selecting a column that does not exist. On 22 September that took every hook down for about two hours, because `settings()` selected `capture_mode` before the migration adding it was applied.
5. If it touches the lifecycle path, add to `tests/memory-lifecycle.test.mjs`, and if it touches what the pass applies, to `tests/consolidation.test.mjs`. That file exists because three bugs that made the whole system inert shipped green past a suite of 141 tests.
6. Read `references/traps.md` before you believe a result.
