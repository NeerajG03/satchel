# Symptoms, and where each one actually came from

Every entry here happened. The pattern worth noticing is that almost none of them looked like what they were.

## "Satchel memory unavailable" on every prompt

Check the `reason` on the error before anything else. Since failures carry a plain sentence, this is usually a one-line answer:

```
reason: embedding is rate limited, the day's free quota is used up (1000 requests)
```

Gemini's free embedding quota is 1,000 requests a day per project per model, and Google counts every input in a batch. A spent daily quota answers with a ~10 second `retryDelay`, which reads exactly like a burst limit. Honouring it buys one request and then fails again, so retrieval looks flaky rather than out of quota. `server/rate-limit.mjs` tells them apart by the `quotaId`.

One eval pass over the corpus is 632 of the 1,000. An eval run six minutes into a quota day once left production with 368 requests for the next twenty-four hours.

If the reason is generic instead, the failure is not from the embedder or the router and `errorText` fell through to its Postgres code table.

## A hook that never runs

Work down this list; it has been every one of them at least once.

1. **Is the plugin version bumped?** `claude plugin update` compares versions and no-ops on equal. A fix nobody can install is not a fix.
2. **Is it an old `mcp_tool` hook?** Every hook has been a `command` script since 0.3.0. An `mcp_tool` hook runs only once the session's MCP servers are up, `SessionStart` at launch fires before that, and the host skips it with `mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)`. If you see that line, the installed plugin is older than 0.3.0.
3. **Does the hook have a credential?** `~/.satchel/credentials.json` must exist. Without it `session-start.mjs` offers the sign-in in a line and every hook answers not connected.
4. **Is the grant alive, for this client?** See `agent_connections` in `references/database.md`.
5. **Is the workspace trusted?** An untrusted folder logs `Skipping ... hook execution - workspace trust not accepted` and runs nothing at all.

And the meta-point: a missing trace was twice read as "the hook never ran" when the real cause was that no prompt had been submitted after the server connected. Produce a positive control before concluding absence.

## "Satchel detected the repository but could not stage it"

This is a **cold start**, not a broken integration.

The bootstrap POSTs to `/api/repository-hint` with a 2,500ms timeout. That endpoint used to reach `SUPABASE_URL` through `http-handler.mjs`, which builds the MCP server, the Supabase client, the embedder and the router, so it loaded the whole model stack to read one string. Production cold start was 2,866ms, just over the budget, and every cold launch produced that message.

The constants live in `server/identity.mjs` now, which imports nothing. Cold start went to 998ms and the module import from 709ms to 30ms. `tests/endpoint-imports.test.mjs` fails if a light endpoint can reach a heavy package again.

## Nothing is ever captured

First check which writer is live: `select capture, capture_mode from memory_settings`. With `session`, the default, **nothing is written at the end of a turn by design**. Memory appears only after the consolidation pass runs, and nothing runs it for a product user yet. Press "Consolidate now" or check the cron, then look at `consolidation_jobs` for the job and `consolidation_runs` for each session. A session is not ready until it has been quiet for 30 minutes.

If the pass ran and changed nothing, that is usually right. Read the trace before deciding it is wrong.

If documents are empty or missing a role, the hooks are the thing to check. The router, the rolling window, `capture_memory`, `router_runs` and the entire Stop branch shipped once with nothing configured to call them.

In `turn` mode, check `router_runs`. `kept=0` with no error is the normal answer: the eval measured the router staying quiet on 16 of 16 turns that held nothing.

## Memories appeared that nobody expected

Not a leak until `memory_events` says so. Ask who wrote them (the query is in `references/database.md`). On 22 September this was the per-turn router, still on because `capture_mode` defaulted to `turn` and had no write grant. Two writers over the same turns save the same claim twice in two wordings.

## Every hook fails at once, right after a push

Suspect the schema before the code. Vercel deploys `main` on push, migrations are applied by hand, and code that selects a column production does not have throws on every request. That took every hook down for about two hours on 22 September. Compare `schema_migrations` with `ls supabase/migrations` first.

## The consolidation model answers 503 or 429 locally

Read the 429 body for its `quotaId` before blaming the model. A free key allows **20 requests a day per model** on the newest Gemini models, and a full consolidation eval is 26. The deployed endpoint uses a different, paid key, so a local failure is not a production one. The fallback to `gemini-3.5-flash` exists for exactly this and shows up as that model name on the generation.

## A generation with no model and no cost

Almost always the projection, not the data. See the field-selection trap in `references/langfuse.md`. Ask for `fields=model,usage` before believing it.

If the fields really are empty, check `genAiToLangfuse` in `server/tracing.mjs`, then whether a model definition matches the model name.

## A number that looks too good

- **100% recall** meant the index was never used: at that corpus size the planner picked a sequential scan, so an exact scan was being compared against an exact scan.
- **35% recall** meant the probe data was uniform random vectors, which are all near-orthogonal in 768 dimensions, so the true top five was arbitrary among thousands of ties.
- **A green verification script** meant `Number(undefined)` was `NaN` and `NaN < 0.9` is false, so it reported success having measured nothing.
- **141 green tests** said nothing about whether the feature worked, because the MCP tests drove a hand-written fake service and the database tests never went through the service. The three bugs lived exactly in the gap.

Assert that the code path you are measuring is the one that ran.

## Git says something impossible

Run `git fetch` before comparing anything to `origin/main`. A stale remote ref once produced a confident report that a migration was applied to production while existing on no merged branch and being untested. Both claims were wrong.

Also worth knowing: other sessions may be editing this working tree at the same time. Check `git status` and `git log` before assuming an unexpected change is yours, and stage files by name rather than with `git add -A`.
