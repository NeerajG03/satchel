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

### Production can hold a migration that exists on no merged branch

`20260917170000_delete_tasks_and_projects` was applied to the live database and lives only on unmerged branches. A rebuild from migrations alone would produce a database missing `delete_task` and `delete_project`, and no test has ever run them.

**Rule:** compare the applied ledger against the repo before touching a live database, and rehearse the chain production actually has.

### Keying a test helper on a filename

The pgvector shim was applied to one migration by name. The next migration to declare `extensions.vector(768)` reached PGlite unshimmed and failed on a domain that cannot take a type modifier. It is driven by file content now.

### 141 green tests said nothing about whether the feature worked

Three bugs that made Memory v2 completely inert all shipped past a full green suite, because the MCP tests drove a hand-written fake service and the database tests never went through the service. The gap between them was exactly where the bugs lived.

### Shipping a feature with nothing configured to call it

The router, the rolling window, `capture_memory`, `router_runs` and the entire Stop branch were all built, tested and deployed, and `build-plugins.mjs` emitted no `Stop` hook. Nothing triggered any of it.

**Rule:** for anything event-driven, assert that the event is configured, not just that the handler is correct.
