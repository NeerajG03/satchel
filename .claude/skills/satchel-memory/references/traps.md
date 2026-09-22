# Traps: the things that produced a confident wrong answer

Every entry here actually happened. The common shape is that none of them threw. They all failed in the direction that looks like success, which is why they got as far as they did.

## Measurement traps

### Uniform random vectors make any index look broken

The first pgvector check filled the probe table with uniform random 768-dimension vectors. In that many dimensions random vectors are all near-orthogonal, so every distance is a near-tie and the true top five is arbitrary among thousands of equals. Measured that way pgvector scores **35% recall**, and it looks like the extension cannot be trusted.

It was fine. The data was wrong. Real embeddings are clustered.

**Rule:** measure retrieval against real embeddings. `scripts/verify-pgvector.mjs` uses the Gemini vectors committed under `eval/embeddings`, padded with convex mixes of two real vectors so every synthetic row stays inside the real embedding cloud. Per-component Gaussian noise does not work for this: a unit 768-dimension vector has components near 0.036, so even small-looking jitter swamps the signal and lands the row back in the random-vector case.

### A perfect score can mean the thing you are testing never ran

The second version of that check probed at 473 rows, the corpus size, and got **100% recall**. That is worse than the 35%, because it looks like success.

At that size the planner picks a sequential scan over HNSW, so both sides of the comparison were exact. It was comparing an exact scan against an exact scan.

**Rule:** assert that the code path you are measuring is the one that ran. The script now reads the query plan and refuses to report a number unless `vector_probe_hnsw` is in it.

### `set local` outside a transaction is silently ignored

The recall comparison turns the index off with `set local enable_indexscan = off` to get ground truth. Outside a transaction that is ignored with no error, the "exact" side uses the index too, and recall comes out at a meaningless 100%.

**Rule:** anything relying on `set local` runs inside an explicit `begin ... commit`.

### Six samples cannot measure a threshold

On the first corpus only six prompts were answerless, and gating looked like a wash. Growing that to 45 showed gating is worth about **0.19 utility**, larger than every other difference in the investigation combined.

Two other conclusions were reported as settled and were wrong for the same reason: embedding `statement+source` was called noise and is a real +0.043, and `all-minilm` was recommended as indistinguishable and is significantly worse by 0.073.

**Rule:** an interval that includes zero means the corpus cannot tell, not that there is nothing there.

### Adding data invalidates old labels

Adding 60 memories to the corpus meant older prompts had to be rechecked. **14 of them had gained a correct answer** they were not credited for. An eval that skips that step quietly measures the wrong thing.

**Rule:** `eval/lib/data.mjs` refuses to run if any prompt is unlabelled, because an unlabelled prompt silently counts as answerless and corrupts the floor.

### A verification tool that fails open is worse than none

`verify-pgvector.mjs` read `Number(measured.recall_at_5)`, which is `NaN` when the report is empty. `NaN < 0.9` is false, so it printed success and exited 0 having measured nothing.

**Rule:** check `Number.isFinite` before comparing against a threshold.

### Rate limits look like failures

A router eval showed nine "failures" that were 429 responses being swallowed. And OpenRouter's free tier is **50 requests a day**, not per minute, which is not obvious until an eval stops halfway.

**Rule:** surface the reason, never just the count.

### A spent daily quota answers like a burst limit

The same trap, one layer down, and it cost a day of retrieval.

Gemini's free embedding quota is **1,000 requests a day per project per model**, and Google counts every input in a batch. When it is gone, the 429 does not say "come back tomorrow". It says:

```
Please retry in 9.878146082s.
details[].RetryInfo.retryDelay = "9s"
```

Ten seconds. That is the bucket refilling at 1,000 a day, so honouring it buys exactly one request and then fails again. Retrieval looked flaky and intermittent when it was simply out of quota, and the intermittency is what kept the real cause hidden: a couple of prompts in ten would work.

Worse, nothing read any of it. Both the embedder and the router read one header, `x-ratelimit-reset`, which **Google does not send at all**. Every Gemini 429 fell through to the 500ms floor, retried once into the same wall, and surfaced as `gemini-embedding-001 returned 429`. The quota name, the limit and the advised delay were all in the response body, which was never read.

**Rule:** the reason for a 429 is in the body as often as in the headers, and a per-day quota is a different thing from a per-minute one. `server/rate-limit.mjs` reads Retry-After, X-RateLimit-Reset and Google's `RetryInfo`/`QuotaFailure` details, and tells a spent day (`quotaId` matching per-day) apart from a burst. A spent day is never slept on.

### A retry that is counted rather than budgeted

The old retry was "wait 500 to 2000ms, once". That number cannot be right, because the thing it has to fit inside is the hook's ten second timeout, and how much of that is left depends on how long the first attempt took.

Retries are budgeted now: `budgetMs` covers the whole call including every wait, an attempt is only started if there is time for one, and an advised wait that does not fit is not taken. Sleeping past the hook timeout means holding the turn open and then failing anyway, which is strictly worse than failing at once, because the caller degrades to silence either way.

The read path gets 6 seconds. `scripts/embed-memories.mjs` gets 60, because a repair is not behind a hook timeout.

### An eval and production sharing one free-tier key

`eval/embed.mjs` used `GEMINI_API_KEY`, which is the same key and therefore the same 1,000-a-day project bucket the deployment retrieves with. One pass over the corpus is 632 texts. An eval run six minutes into a quota day left production with 368 requests for the next twenty-four hours.

**Rule:** the eval asks for `SATCHEL_EVAL_GEMINI_KEY`, and when it falls back to the deployment's key it prints what it is about to spend before spending it. A cost that is invisible until it is paid is a cost that gets paid by accident.

### A free key failing locally says nothing about production

On 22 September `gemini-3.8-flash` answered 503 on every attempt from this machine, and that was written into `decisions.md` as the model being overloaded. It was not. The local key is free tier, which allows **20 requests a day per model** on the newest models, and the eval had spent it. The deployed endpoint answered on the same model in 3.7 seconds the same afternoon, because Vercel holds a paid key.

**Rule:** before calling a model broken, read the 429 body for its `quotaId`, and check the same call through production. Two keys are two different facts.

### A generic error message for a specific failure

Every failure from the embedder and the router landed on the default branch of `errorText`, because that table keys on Postgres error codes and an `EmbeddingError` has none. So a spent quota reached the person as:

> Satchel memory unavailable · Satchel request failed. Reload before retrying a write: it may have completed.

Every clause after the first four words is wrong. There was no write. Reloading does nothing. And the one fact that would have ended the debugging in a minute was thrown away with the response body.

**Rule:** a failure that can say what it was carries a plain-words `reason`, and `errorText` prefers it over the code table.

## Code traps

### An explicit NULL is not an absent argument

`p_gate real default 0.67` applies when the argument is **absent**. The service sent `p_gate: args.gate ?? null`, which reaches Postgres as NULL, so the filter became `score >= NULL`, which is NULL, which is not true. Every row was dropped and retrieval returned nothing, everywhere, silently.

**Rule:** omit a key to mean "use the default". Never send null for it. And have the function `coalesce` anyway, so any future caller is safe either way.

### A block-scoped `const` shadows the whole block, including above itself

```js
let context;
if (event === 'Stop') {
  setInput({contextMessages: context.length});   // ReferenceError
  const context = ordered.slice(...);            // this shadows the outer one for the WHOLE block
}
```

The read is in the temporal dead zone. It threw on every Stop, the surrounding catch turned it into a generic "memory unavailable" string, and capture silently never ran.

**Rule:** do not reuse an outer name for a block-scoped variable. The inner one here is called `earlier`.

### A new column is not read until it is named in the select

`capture` and `capture_window` were added to `memory_settings` by a migration, and `settings()` was never updated. `settings.capture` was `undefined` on every request, so capture short-circuited and the rolling window was never written either. Turning the setting on in the database changed nothing.

**Rule:** `tests/memory-lifecycle.test.mjs` asserts every column the lifecycle path reads is in the select **and** in the no-row fallback, and that the fallback values match the column defaults. A fallback that disagrees with the schema makes behaviour depend on whether a row happens to exist.

### An SDK error class does not mean what its name suggests

Moving the model calls to the Vercel AI SDK, the first classification was written from the class names and got three cases wrong. Probing each one found:

- a count mismatch raises `InvalidResponseDataError`, which is **not** an `APICallError`, so "not an APICallError means timeout" reported a malformed response as *the service did not answer in time*;
- an unreadable body on a successful request still raises `APICallError`, with `statusCode` **200**, so reporting the status gave a person *the service answered 200*;
- only an abort is really a timeout, and that has to be read off the signal, because the SDK surfaces it as an ordinary error.

**Rule:** `describeFailure` in `server/model-provider.mjs` is the one place that decides, and it was written against probe output rather than documentation. Probe a new error path before mapping it.

### `undefined` falls through to a default that reads the environment

`tests/router.test.mjs` built a router with `apiKey: undefined` to test the no-key path. A destructured default treats `undefined` as missing, so it fell through to `process.env.GEMINI_API_KEY`, and the test passed or failed depending on whether the shell running it exported a key. It is `apiKey: null` now.

**Rule:** to say "none" to a parameter with an environment default, pass `null`.

### An error wrapper that drops the status

`asModelError` turned every SDK failure into a `RouterError` with a code and a reason, and dropped the HTTP status on the way. The fallback decides on `status >= 500`, so with the status gone a 400, which is the request and fails identically on every model, would have been retried on a second model and billed twice. It was found by reading the code after a wrong diagnosis, not by a test.

**Rule:** a wrapper keeps every field something downstream decides on. Write the test for the decision, not for the wrapper.

### A default parameter makes its own fallback unreachable

```js
path = process.env.SATCHEL_EMBEDDING_PATH ?? '/embeddings'
...
url + (path ?? spec.path)   // spec.path can never be used
```

The per-provider path was dead code and ollama posted to the wrong endpoint. Nine ollama tests stubbed fetch and none looked at the URL.

**Rule:** if you write `a ?? b`, make sure `a` can actually be nullish.

### Column privileges are per column

New columns on `memories` are not writable until they are named in a `grant insert(...)` and `grant update(...)`. Nothing reminds you.

### A before-update trigger fires on writes that are not edits

`stamp_memory_revision` bumped the revision on **any** update, so backfilling an embedding took live memories from revision 1 to revision 2 without a word of their text changing. The revision is the optimistic concurrency token, so every client holding the old one gets a conflict it cannot explain, and the person sees "edited just now" on a row nobody touched. Re-embedding after a model change would do it to the whole corpus at once.

The shape migration had already worked around this by disabling the trigger around its own backfill, which was a local patch for a general problem. The trigger now bumps only when the statement, source, more_info, name, band, project or task changes.

### Recreating a function can revert an earlier migration

Recreating `save_memory` and `correct_memory` for the v2 shape quietly reverted an earlier change from error code PT409 back to 40001. `tests/agent-connections.test.mjs` caught it.

**Rule:** when you recreate a function, read every migration that touched it first.

### Postgres refuses `ON DELETE SET NULL` on a key containing a generated column

`tasks.scope_key` is generated, so `memories_task_fkey` references `tasks(owner_id, id)` instead, and scope agreement is enforced inside `save_memory` where it can raise something a person can read.

### A view expands `t.*` at creation time

`task_planning` had to be recreated by the slugs migration, because `select t.*` was already expanded to the column list that existed when the view was made. A new column does not appear on its own.

### A row type in plpgsql is not automatically safe across a schema change

`delete_task` declares `target public.tasks`, and adding a `slug` column changes that composite type. It works, but it is worth rehearsing rather than assuming: the production chain including that function was replayed locally before the migrations were applied.

### Codex has no `last_assistant_message`

The placeholder arrives as its own literal text. Recording it would put the string `${last_assistant_message}` into the window the router reads, on every turn, on that host. The server discards anything still shaped like `${...}`.

## Process traps

### A smoke test that skips a layer proves nothing about that layer

Memory v2 was reported working after a live end-to-end check that called `search_memories` **directly in SQL**. Every critical bug was in the service layer that check skipped. Direct SQL returned two rows; the same query through the service returned zero.

**Rule:** smoke test the path production actually takes, not a shortcut to the same data.

### A stale remote ref makes normal work look like drift

I reported that `20260917170000_delete_tasks_and_projects` was applied to production while existing on no merged branch, and that nothing tested it. Both were wrong. `git fetch` had not been run, so `origin/main` pointed at a commit from days earlier. The migration is on `main`, and `tests/delete.test.mjs` covers it.

The local `main` branch was stale in the other direction too: its tip existed on the remote under a different hash, because the work had been rebased.

**Rule:** `git fetch` before comparing anything against `origin/main`, and before concluding that a branch is behind, ahead or divergent. Comparing the applied migration ledger against the repo is still worth doing; just do it against a ref that is actually current.

### Keying a test helper on a filename

The pgvector shim was applied to one migration by name. The next migration to declare `extensions.vector(768)` reached PGlite unshimmed and failed on a domain that cannot take a type modifier. It is driven by file content now.

### 141 green tests said nothing about whether the feature worked

Three bugs that made Memory v2 completely inert all shipped past a full green suite, because the MCP tests drove a hand-written fake service and the database tests never went through the service. The gap between them was exactly where the bugs lived.

### An mcp_tool hook cannot run before the MCP servers are up

`SessionStart` at launch fires before the session's MCP servers are available to hooks, so Claude Code skips the event's `mcp_tool` hooks without calling them and logs `mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)`. `--continue` and `--resume` count as launch. After a `/clear` or a compaction the servers are already up and the hook does run, so the same event works or does not depending only on why it fired.

Satchel matched all four sources for a long time, which produced a visible hook error on every single launch and never once ran. As of plugin 0.3.0 there is no `mcp_tool` hook at all: every hook is a `command` script holding its own credential.

**Rule:** a hook handler type has preconditions, and the event firing is not the same as the handler being able to run.

### Deployed code ahead of the schema

Vercel deploys `main` on every push. Migrations are applied by hand. On 22 September server code that selected `memory_settings.capture_mode` deployed before the migration that added it, `settings()` threw on every request, and every hook in every session failed for about two hours. The suite was green, because the suite runs every migration.

**Rule:** apply first, push second. Nothing enforces this yet, so it is on whoever pushes.

### Two writers over the same turns

The consolidation pass shipped with `capture_mode` still defaulting to `turn`, so the old per-turn router kept writing. New memories showed up that the pass had not made, and they read like a leak. `memory_events.actor` and `trace_id` settled it in one query: the router, from Stop traces. Separately, `capture_mode` had no write grant, so nobody could have switched it off from the app anyway.

**Rule:** when a new writer replaces an old one, switching the old one off is part of the same change. And when a memory appears that nobody expected, ask `memory_events` who wrote it before reading any code.

### A trace a minute old is not missing

A Stop trace absent from Langfuse was reported as a regression. It arrived about a minute later. Ingestion is not immediate.

**Rule:** before calling a trace missing, wait, and query for one you know exists through the same filter.

### Shipping a feature with nothing configured to call it

The router, the rolling window, `capture_memory`, `router_runs` and the entire Stop branch were all built, tested and deployed, and `build-plugins.mjs` emitted no `Stop` hook. Nothing triggered any of it.

**Rule:** for anything event-driven, assert that the event is configured, not just that the handler is correct.

**`indexedText` and `toVectorLiteral` live in `vector.mjs`, not `embedding.mjs`.** They are two pure functions and `embedding.mjs` imports the Vercel AI SDK, so importing them from there loads `ai` into every endpoint that touches the service, including the one a session start waits on. Same trap `identity.mjs` was carved out to fix, and `tests/endpoint-imports.test.mjs` is what catches it.

**Tracing is passed into `lifecycle.mjs`, not imported by it.** `tracing.mjs` pulls in `ai`, the OpenTelemetry node SDK and three Langfuse packages. Capture passes the real `traced`; session start does not, because it runs inside a hook timeout when a session opens and `memory_injections` already records what was injected. Turning that parameter back into an import is a 700ms cold start on the most latency-sensitive endpoint in the product.

**A comparison against a nullable variable is null, not false.** `resolve_agent_repository` returned `(p.id = chosen)` for its `selected` column, and with nothing chosen every candidate came back `null`, so a caller checking `=== false` saw none of them as unselected. `coalesce(..., false)`. The SQL test caught this and reading it twice did not.
