---
name: debugging
description: How to find out what Satchel actually did, rather than what the code says it should do. Use when something is not working and you need evidence: a hook that did not fire, a memory that was not retrieved or not captured, a request that failed, a cost you cannot account for, a latency you cannot explain. Covers reading Langfuse traces and querying the live database, how to get access to both, and which questions each one can answer.
---

# Debugging Satchel

The code is not the evidence. Satchel runs as hooks inside someone else's agent, against a serverless handler, calling two hosted models, writing to a hosted Postgres. Every one of those can succeed in a way that looks like failure, or fail in a way that looks like silence.

There are exactly two places that know what really happened:

| Source | Answers | Does not answer |
| --- | --- | --- |
| **Langfuse** | what the models were asked and what they said, how long it took, what it cost, why a call failed | whether a row was written |
| **The database** | what is stored now, what was injected, what the router kept | what the model saw, or why |

Most real investigations need both, in that order: Langfuse says what happened in the request, the database says what survived it.

## Read this first, then route

| What you are chasing | Read |
| --- | --- |
| A model call: prompt, reply, tokens, cost, latency, an error | `references/langfuse.md` |
| Stored state: memories, injections, router runs, grants, hints | `references/database.md` |
| A symptom you have seen before | `references/symptoms.md` |

## The one rule that outranks the rest

**An empty result is not evidence of absence until you have checked that you asked for the thing.**

This has cost real hours, more than once, in both directions:

- A missing trace was read as "the hook never ran". The hook had run; no prompt had been submitted after the MCP server connected, so there was nothing to trace.
- `modelId: null` on every observation was read as "Langfuse is not mapping the AI SDK attributes". The field was simply not in the default projection. Asking for `fields=model,usage` showed the model resolved, the tokens recorded and the cost computed all along.

Before concluding that something did not happen, prove that a positive case shows up through the exact same query. If you cannot produce a positive control, you have not measured anything.

## Order of operations

1. **Reproduce against the real path.** Not a unit test, not direct SQL. Memory v2 was reported working after a smoke test that called `search_memories` in SQL; every bug was in the service layer that test skipped. Direct SQL returned two rows, the same query through the service returned zero.
2. **Find the trace.** Group by `sessionId`, which is the agent's session key. One lifecycle event is one trace.
3. **Read the error, not the status.** Everything the embedder and the router throw carries a plain-words `reason`. If you are looking at a status code you are one level too shallow.
4. **Then check what was stored**, because a successful call and a written row are different claims.

## What never goes in a debugging session

No service role key, ever, in a command, a file or a message. No secrets pasted into chat. Credentials live in `~/.config/env` and are read from there. Queries against production are read-only unless the change is the fix and you have said so out loud first.
