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
GEMINI_API_KEY                  both the embedder and the router
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
LANGFUSE_BASE_URL
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY   the server's only database key; RLS does the rest
SATCHEL_GITHUB_APP_*
```

`SUPABASE_URL` is a constant in `server/http-handler.mjs`. `SUPABASE_SERVICE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are used only by local maintenance scripts and are deliberately **not** on Vercel. `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` are only for `verify-pgvector.mjs`.

Overridable without a code change: `SATCHEL_EMBEDDING_PROVIDER|MODEL|URL|PATH|KEY|DIMENSIONS|TIMEOUT_MS|BUDGET_MS|FALLBACK_KEY|FALLBACK_URL`, `SATCHEL_ROUTER_MODEL|URL|KEY|TIMEOUT_MS`.

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

## Smoke testing a release

Test the path production takes. Memory v2 was once reported working after a check that called `search_memories` directly in SQL, and every critical bug was in the service layer that check skipped: direct SQL returned two rows, the same query through the service returned zero.

The real check goes through `memoryService`:

```
settings()            must carry capture and capture_window, not just the four ranking columns
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

The router model is pinned rather than floating, because the prompt was tuned against that version and an alias would move the thing the measurement describes.
