# Running it: migrations, embeddings, verification, tracing

## The live project

```
Supabase   Satchel   ref prpgcrwteepcunizdcut   ap-southeast-2   Postgres 17.6
Vercel     satchel   https://satchel-pi.vercel.app/api/mcp
pgvector   0.8.2, installed into the `extensions` schema
```

## Applying migrations

The Supabase CLI is not installed and there is no database password on hand. What works is the management API with the personal access token the CLI stores in the macOS keychain:

```bash
SB_TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST -H "Authorization: Bearer $SB_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select 1;"}' \
  "https://api.supabase.com/v1/projects/$REF/database/query"
```

It runs as `postgres` and can create extensions. Each migration file wraps itself in `begin ... commit`, so applying one is a single request.

Applying this way does **not** write the ledger, so insert the row yourself or the CLI falls out of sync:

```sql
insert into supabase_migrations.schema_migrations(version, name, statements)
values ('20260920130000', 'retrieval_and_slug_fixes', array[$sql$...$sql$]);
```

### Apply before you push

Vercel deploys `main` the moment it lands. Migrations are applied by hand. So the order is: apply the migration, check it landed, then push the code that reads it. The other order is an outage, not a warning. On 22 September server code that selected `memory_settings.capture_mode` deployed before the migration adding the column, `settings()` threw, and every hook failed for about two hours until nine migrations were applied. Nothing guards this yet.

To see what production is missing, compare `supabase_migrations.schema_migrations` against `ls supabase/migrations`.

### Before you touch the live database

1. **`git fetch`, then compare the ledger against the repo.** Without the fetch, a stale `origin/main` makes ordinary work look like drift: I once reported a live migration as existing on no merged branch when it was on `main` and covered by a test.
2. **Back up what you are about to change.** Even two rows.
3. **Rehearse the chain production actually has** against PGlite. That is what caught that `delete_task` declares `target public.tasks` as a row type while the slugs migration adds a column to that table.

## Backfilling embeddings

```bash
SUPABASE_SERVICE_KEY=... npm run memories:embed -- --dry-run
SUPABASE_SERVICE_KEY=... npm run memories:embed
```

A repair, not a migration: re-runnable, interruptible, and it never touches a row it does not need to. It picks up rows with no embedding **or** an embedding from a different model, which is why the model name is stored next to every vector.

The service key comes from the management API rather than being pasted anywhere:

```bash
curl -s -H "Authorization: Bearer $SB_TOKEN" \
  "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true"
```

Backfilling does **not** bump revisions any more. It used to, which is what `20260920120000_embedding_is_not_an_edit` fixed.

## Verifying pgvector

```bash
SUPABASE_ACCESS_TOKEN=sbp_... npm run verify:pgvector
# optional: node scripts/verify-pgvector.mjs <rows> <ef_search>
```

It loads the real Gemini embeddings from `eval/embeddings`, pads to 5000 rows with convex mixes of real vectors, asserts the planner actually chose HNSW, and measures recall@5 against an exact scan with the index disabled. It cleans up its own tables and fails closed.

```
recall@5   98.7%   (a re-run gave 98.9%; HNSW construction is randomised,
                    so expect a couple of tenths of a point either way)
HNSW 0.85ms mean against 28.23ms for the exact scan, ef_search 40
```

Below 90% means raising `hnsw.ef_search`, or the eval's measured quality does not transfer.

## Environment

Set on Vercel Production and Preview:

```
GEMINI_API_KEY                  the embedder, the router and the consolidation pass
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
LANGFUSE_BASE_URL
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY   the server's only database key; RLS does the rest
SATCHEL_GITHUB_APP_*
```

`SUPABASE_URL` is a constant in `server/http-handler.mjs`. `SUPABASE_SERVICE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are used only by local maintenance scripts and are deliberately **not** on Vercel. `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` are only for `verify-pgvector.mjs`.

Overridable without a code change: `SATCHEL_EMBEDDING_PROVIDER|MODEL|URL|KEY|DIMENSIONS|TIMEOUT_MS|BUDGET_MS|TASK_TYPE|FALLBACK_KEY|FALLBACK_URL`, `SATCHEL_ROUTER_PROVIDER|MODEL|URL|KEY|TIMEOUT_MS`, `SATCHEL_THINKING_LEVEL`, `SATCHEL_MODEL_FALLBACK`, `SATCHEL_MODEL_AVOID_MS`, `SATCHEL_CONSOLIDATE_TIMEOUT_MS`, `SATCHEL_PROMPT_LABEL|TIMEOUT_MS|TTL_MS`.

The router and the pass share `SATCHEL_ROUTER_MODEL` (default `gemini-3.8-flash`) and `SATCHEL_THINKING_LEVEL` (default `medium`). `SATCHEL_MODEL_FALLBACK` defaults to `gemini-3.5-flash`; set it to the same model, or to an empty string, to switch the fallback off.

**Production's Gemini key is not the local one.** Production is on a paid key; a local free key allows 20 requests a day per model on the newest models. A local 429 or 503 is not evidence about production, and was once misread as exactly that.

`SATCHEL_EMBEDDING_PATH` is gone: the SDK builds the path from the base URL. A `_URL` still naming a full endpoint is trimmed rather than left to 404, so an old value keeps working. A provider name must be one of `google`, `openai`, `openai-compatible`, `openrouter`, `ollama`; anything else is a startup error, because a typo used to become a silent call to whatever host happened to be the default.

## The model calls go through the Vercel AI SDK

`server/model-provider.mjs` builds the provider, and `ai`'s `embed`/`embedMany` and `generateObject` make the calls. Google natively rather than through its OpenAI compatibility layer, because two things only exist on the native API: `taskType`, and structured output the provider enforces instead of being asked for. Any OpenAI-shaped host is still a provider name plus a url.

What the SDK does **not** own, and why:

| stays ours | because |
|---|---|
| L2 normalisation | the SDK does not normalise, and at 768 dimensions this model returns un-normalised vectors |
| the dimension guard | a model ignoring `outputDimensionality` must throw, not store short |
| the retry policy | `maxRetries: 0` on every call. The SDK's backoff cannot know a per-day `quotaId` means waiting is pointless, and its default of two retries would spend the hook's whole timeout learning that |
| the fallback key | no core equivalent |
| `validate()` | the schema guarantees the shape; only this can check the source is really in what the user typed |

`describeFailure` in `model-provider.mjs` classifies an SDK error, and it was written by probing each case rather than from the class names. A count mismatch raises `InvalidResponseDataError`, which is not an `APICallError`; an unreadable body raises `APICallError` with `statusCode` **200**; and only an abort is really a timeout. Reading those wrongly reported a malformed response as "the service did not answer in time" and an unreadable body as "the service answered 200".

Telemetry is `registerTelemetry(new LangfuseVercelAiSdkIntegration())`, once, in `tracing.mjs`. The SDK emits its own `embeddings {modelId}` and `chat {modelId}` observations. Verified against the live project: an `EMBEDDING` and a `GENERATION` arrive correctly typed under our own event span. The list endpoint's projection omits `model` and `usageDetails`, so confirm token usage in the UI rather than through `/api/public/v2/observations`.

## taskType, built and deliberately switched off

`gemini-embedding-001` is asymmetric: a stored memory wants `RETRIEVAL_DOCUMENT` and the prompt looking for it wants `RETRIEVAL_QUERY`. The OpenAI compatibility layer had no field for it, so Satchel has never used it.

`SATCHEL_EMBEDDING_TASK_TYPE` turns it on and **nothing sets it**. Turning it on changes the embedding space, so every vector already stored would be compared against query vectors from a different space: retrieval gets quietly worse and nothing fails. Opting in therefore changes `embedder.model` to `gemini-embedding-001+retrieval`, so `embedding_model` still tells the two spaces apart and the backfill knows the corpus needs re-embedding.

Order of operations if you want it: run the eval with it on, compare utility, recalibrate the gate, then re-embed and switch. Not the other way round. And one eval pass over the corpus is 632 requests of a 1,000 a day free quota.

## The embedding quota, which is a capacity limit and not a bug

`gemini-embedding-001` on the free tier allows **1,000 requests a day per project per model**, and Google counts **every input in a batch**, so a batch of 64 costs 64. The day resets at midnight US/Pacific, which is 12:30 IST.

That number is small enough to matter. One pass of `eval/embed.mjs` over the corpus is 473 memories plus 159 prompts, so **632 of the 1,000**. On 20 September 2026 an eval run six minutes into the quota day took most of the budget, and production retrieval spent the rest of the day answering "Satchel memory unavailable" on every prompt.

Three things follow.

**The eval takes its own key.** `SATCHEL_EVAL_GEMINI_KEY` if it is set, otherwise the deployment's `GEMINI_API_KEY` with a line saying what it is about to spend. Set the dedicated one before any embedding work.

**A second key doubles the ceiling.** The quota is per project, so `SATCHEL_EMBEDDING_FALLBACK_KEY` (a second Google project's key) is tried when the first route is rate limited. It is deliberately the *same model* on a different key, with no setting to make it anything else: `embedding_model` is stored beside every vector because two models' vectors are not comparable, so a fallback that answered with a different model would turn a rate limit into quietly wrong matches.

**Waiting does not fix a spent day.** Google answers an exhausted per-day quota with a ~10 second `retryDelay`, which is the bucket refilling at 1,000 a day and reads exactly like a burst limit. Honouring it buys one request and then fails again, which is what made retrieval look flaky rather than out of quota. `server/rate-limit.mjs` tells the two apart from the `quotaId` and the embedder does not sleep on a spent day.

Beyond that the answer is billing, not code: the paid tier lifts the limit.

Keys live in `~/.config/env` and never in the repo. `.env` and `.env.*` are gitignored. When setting a Vercel variable, pipe the value from the env file so the key never appears in visible command text.

## Tracing

Langfuse, US cloud. One trace per lifecycle event, grouped by session.

Two things worth knowing before debugging it:

- **Tags belong on `propagateAttributes`, not on the span.** In SDK v5 correlating attributes live on every observation, so setting them on one span leaves its children untagged and unfilterable.
- **`langfuse-cli api traces get` uses a deprecated endpoint.** Organisations created after 16 September 2026 get `LEGACY_API_UNAVAILABLE_FOR_NEW_ORGANIZATION`, and `observations list` returns 0 while the traces are arriving perfectly well. Use `GET /api/public/v2/observations`. This cost a long debugging session chasing an export that was never broken.

Spans are flushed in a `finally` before the handler returns, because a serverless function can freeze the moment it responds.

## Running the consolidation pass

Three ways, all through `/api/consolidate`, all under RLS as the owner:

- **The button.** "Consolidate now" on the activity page in dev mode, with the person's browser session.
- **The developer cron.** `npm run consolidation:enable -- --enable` runs one OAuth flow for a separate client, stores the refresh token in Vault, and schedules `private.run_consolidation` through `pg_cron` and `pg_net`. Needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`. `consolidation_status()` says whether the job installed. Not surfaced to product users on purpose.
- **By hand**, with a hook credential as the bearer, for a test.

A quiet run is normal. `consolidation_runs` has a row for every document read, including the ones that changed nothing, and `memory_events` has one for every change, carrying the trace id.

## Smoke testing a release

Test the path production takes. Memory v2 was once reported working after a check that called `search_memories` directly in SQL, and every critical bug was in the service layer that check skipped: direct SQL returned two rows, the same query through the service returned zero.

The real check goes through `memoryService`:

```
settings()            must carry capture, capture_window, capture_mode, block_size and staleness_commits
search({query})       with nothing else supplied, must still return rows
search({query, gate, boost, limit})   must return the same or fewer
an unrelated question must return zero
```

## Model changes

Changing the embedding model means:

1. Add it to `eval/embed.mjs` and cache an index.
2. `npm run eval` to get its calibrated gate and its utility with an interval.
3. Only adopt it if the paired difference excludes zero.
4. Update `memory_settings.gate` to the calibrated value.
5. Re-embed everything. The pairing constraint is what makes a half-migrated corpus impossible rather than merely mediocre.
6. Re-run `verify:pgvector` if the dimension count changed.

The router and consolidation model is pinned rather than floating, because the prompts were tuned against that version and an alias would move the thing the measurement describes. Changing it means `node eval/consolidation.mjs` on the new model with a paid key, then `--update-baseline` only after reading it.
