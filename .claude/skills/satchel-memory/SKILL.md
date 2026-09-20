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

**The transcript is never read from disk.** Both hosts hand the prompt to the hook as an argument. The rolling window lives in the database, server side, trimmed on write and expired after 24 hours. No transcript file is parsed on either host, and no conversation is kept beyond that window.

**Numbers in migrations are measured, not chosen.** The gate of 0.67, the boost of 1.1 and the cap of 5 each have a measurement behind them in `references/decisions.md`. The gate in particular is per embedding model: the same corpus gives 0.43 for all-minilm and 0.28 for nemotron. Changing the embedding model means re-running `eval/run.mjs` and updating the setting, not guessing.

**Everything proprietary runs on the server.** Hooks carry a session key and a prompt to an MCP endpoint and nothing else. No key, no prompt text, and none of the ranking or routing logic ever lands on the user's machine.

## Where things live

```
server/
  mcp-server.mjs        the tool surface and the lifecycle handler (SessionStart, UserPromptSubmit, Stop)
  memory-service.mjs    the only place that talks to the database
  embedding.mjs         text to vector, provider independent, always L2 normalised
  router.mjs            the end-of-turn capture model: prompt, schema, and validation
  injection-format.mjs  the exact bytes that reach the model, kept pure
  tracing.mjs           Langfuse, safe to call when unconfigured, never throws into a request
supabase/migrations/    the schema, the functions and every policy
eval/                   the corpus, the labels, the metrics and the baseline
scripts/                verify-pgvector.mjs, embed-memories.mjs
```

## When you change something

1. If it touches ranking, gating, scoping or what gets embedded, re-run `npm run eval`. It compares against `eval/baseline.json` and exits non-zero on a regression worse than 0.02.
2. If it touches the schema, add a migration. Never edit an applied one except to correct a comment, and if you do that, resync the recorded statement so the file and the ledger agree.
3. If it touches the lifecycle path, add to `tests/memory-lifecycle.test.mjs`. That file exists because three bugs that made the whole system inert shipped green past a suite of 141 tests.
4. Read `references/traps.md` before you believe a result.
