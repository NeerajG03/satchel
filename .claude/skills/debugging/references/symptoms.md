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
2. **Is the matcher right?** An `mcp_tool` hook runs only once the session's MCP servers are available to hooks. `SessionStart` at launch fires before that and is skipped with `mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)`. `--continue` and `--resume` count as launch. After `/clear` or a compaction the same hook runs normally. So the matcher is `clear|compact` only, and launch is covered by the bootstrap command hook.
3. **Is the MCP server connected?** In print or headless mode the lazy dedup suppresses the plugin server *and* the connector, so neither connects and every `mcp_tool` hook is skipped. Interactive mode resolves it the other way.
4. **Is the grant alive, for this client?** See `agent_connections` in `references/database.md`.
5. **Is the workspace trusted?** An untrusted folder logs `Skipping ... hook execution - workspace trust not accepted` and runs nothing at all.

And the meta-point: a missing trace was twice read as "the hook never ran" when the real cause was that no prompt had been submitted after the server connected. Produce a positive control before concluding absence.

## "Satchel detected the repository but could not stage it"

This is a **cold start**, not a broken integration.

The bootstrap POSTs to `/api/repository-hint` with a 2,500ms timeout. That endpoint used to reach `SUPABASE_URL` through `http-handler.mjs`, which builds the MCP server, the Supabase client, the embedder and the router, so it loaded the whole model stack to read one string. Production cold start was 2,866ms, just over the budget, and every cold launch produced that message.

The constants live in `server/identity.mjs` now, which imports nothing. Cold start went to 998ms and the module import from 709ms to 30ms. `tests/endpoint-imports.test.mjs` fails if a light endpoint can reach a heavy package again.

## Nothing is ever captured

Check `router_runs` first. `kept=0` with no error is the normal answer and not a failure: most turns contain nothing durable, and the eval measured the router staying quiet on 16 of 16 turns that held nothing.

If it is not even running, the Stop hook is the thing to check. The router, the rolling window, `capture_memory`, `router_runs` and the entire Stop branch all shipped once with nothing configured to call them.

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
