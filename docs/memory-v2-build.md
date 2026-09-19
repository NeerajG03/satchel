# Memory v2: end to end build plan

20 September 2026. Companion to [Memory v2](memory-v2.md), which holds the design and the reasoning. This document holds the work.

Every platform claim here is cited to official documentation. Every database claim was produced by running the query against real Postgres and pasting the output. Where I could not verify something, it sits in section 12 marked unverified, not in the plan.

---

## 1. How this was verified

| Claim class | Method |
|---|---|
| Claude Code hook behaviour | [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) |
| Codex hook behaviour | [learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks) (canonical URL `developers.openai.com/codex/hooks` 308s here) |
| Known Codex defect | [openai/codex#45999](https://github.com/openai/codex/issues/45999) |
| Retrieval behaviour | PGlite 0.5.8, which reports `PostgreSQL 18.3`, the same engine the test suite already runs |
| Current Satchel behaviour | the files in this repository, cited by path and line |

The retrieval probes below are throwaway scripts I ran against the repo's own `@electric-sql/pglite` and then deleted. Output is pasted unedited.

---

## 2. What exists today

### 2.1 Schema

`memories` is three text columns plus scope, from [202609100001_foundation.sql](../supabase/migrations/202609100001_foundation.sql) and [202609100002_named_memories.sql](../supabase/migrations/202609100002_named_memories.sql):

```
id, owner_id, project_id (nullable = personal), revision, created_at, updated_at
name        text not null, 1..100      unique per scope, case-folded
description text not null, 1..280
more_info   text default '', <= 40000
```

Things that matter for the migration and are easy to miss:

- `memories_scope_name` and `memories_personal_name` are **unique indexes on `lower(btrim(name))`**. Making `name` nullable does not remove them, and a partial index is needed so many NULL-named rows can coexist.
- Table privileges are **column level**: `grant insert(id, project_id, name, description) ... grant update(name, description)`. A new column is not writable until it is granted explicitly. This is in both foundation and named-memories migrations.
- `stamp_memory_revision` is a `before update` trigger that bumps `revision` and sets `updated_at`. Any new write path inherits it for free.
- RLS for agents is `agent_memory_read/insert/update/delete` in [202609110003_agent_connections.sql](../supabase/migrations/202609110003_agent_connections.sql), all gated on `public.agent_can_access(project_id, write)`.

`tasks` is in [20260916070509_task_management.sql:99](../supabase/migrations/20260916070509_task_management.sql), made scope-nullable by [20260916154226_personal_tasks.sql](../supabase/migrations/20260916154226_personal_tasks.sql) using a generated `scope_key` column rather than a synthetic project row.

### 2.2 What is simply absent

```
$ grep -rn "slug" supabase/ server/ src/ integrations/
(only a Supabase CLI temp file, no application use)

$ grep -rniE "tsvector|pg_trgm|vector|embedding|websearch_to_tsquery" supabase/ server/ src/
(no matches)
```

So slugs, full text search, and any vector work are all new. There is also no settings table, no injection log, and no context preview anywhere in `src/`.

Projects have **no uniqueness constraint on `name`** either. `projects` is `unique (owner_id, id)` only. The design's "unique per user" slug is a new constraint, not a rename of an existing one.

### 2.3 The current injection path

`SessionStart` runs two handlers per [integrations/claude/satchel/hooks/hooks.json](../integrations/claude/satchel/hooks/hooks.json): a local `command` bootstrap that stages the git remote, then an `mcp_tool` call to `load_memory_context`. That tool builds its payload in [server/mcp-server.mjs:84](../server/mcp-server.mjs) and is capped hard:

```js
// server/mcp-server.mjs:96
if (!complete||Buffer.byteLength(data,'utf8')>1800) {
  context='Satchel index NOT loaded completely: ...';
}
```

1,800 bytes, and if the index does not fit **nothing** is injected. Section 6.1 of the design budgets roughly 1.8k *tokens*, which is about four times that. The budget constant has to move, and it should become a setting rather than a literal.

The other ceiling is [server/memory-service.mjs:41](../server/memory-service.mjs):

```js
return {memories:rows,complete:count!==null&&count===rows.length&&rows.length<501};
```

`list_memories` is ordered by `lower(name)`, so at 501 rows you get the alphabetically first 501 and a false `complete`. Retrieval replaces this, but the ceiling stays relevant for the personal scope load.

### 2.4 The tests actively forbid the thing we are about to add

```js
// tests/plugin-bootstrap.test.mjs:60
assert.equal(hooks.UserPromptSubmit,undefined);
```

And the bootstrap script rejects the event outright:

```js
// integrations/shared/bootstrap.mjs:14
if(!['SessionStart','PostCompact'].includes(event.hook_event_name))process.exit(0);
```

Matched by [server/mcp-server.mjs:10](../server/mcp-server.mjs), `lifecycle=z.enum(['SessionStart','PostCompact'])`. Three places enforce the no-per-prompt-hook decision. All three change together, and the test flips from "asserts absent" to "asserts present and shaped correctly".

---

## 3. The two hosts are not symmetric

This is the single most important research finding, and the design document currently assumes they are.

| Capability | Claude Code | Codex |
|---|---|---|
| `SessionStart` + `additionalContext` | yes | yes, but see [#45999](https://github.com/openai/codex/issues/45999) |
| `SessionStart` matcher sources | `startup`, `resume`, `clear`, `compact`, `fork` | `startup`, `resume`, `clear`, `compact` |
| `UserPromptSubmit` + `additionalContext` | yes | yes |
| `UserPromptSubmit` carries the prompt text | yes | yes, field `prompt` |
| `Stop` + `additionalContext` | **yes**, delivered as a system message on the next turn | **no**, only `continue` / `stopReason` / `systemMessage` |
| `Stop` carries the assistant's final text | yes, `last_assistant_message` | no |
| `PostCompact` + `additionalContext` | yes | **no** |
| `PreCompact` + `additionalContext` | yes | no |
| Handler types | `command`, `http`, `mcp_tool`, `prompt`, `agent` | `command`, `mcp_tool` only. "prompt and agent handlers are parsed but skipped." |
| `${session_id}` in config | **not supported**, read `session_id` from stdin | supported, `${field.nested}` expansion in `mcp_tool` `input` |
| `async: true` | command hooks only, no timeout enforced | yes, max 8 background hooks per session, output delivered "at the next safe point" |
| Oversized output | not documented as spilling | `additionalContextLimit`, default 2500 tokens, spills to a temp file and shows a preview |
| Default timeout | 600s, but 30s for `UserPromptSubmit` | 600s, 1s for `SessionEnd`/`Interrupt` |

### 3.1 What this changes

**Three live defects in the shipped Codex package.**

1. [scripts/build-plugins.mjs:31](../scripts/build-plugins.mjs) writes a Codex `PostCompact` hook whose whole job is returning `additionalContext`. Codex does not support `additionalContext` on `PostCompact`. After a compaction on Codex, memory is not reloaded. [docs/memory-hooks.md](memory-hooks.md) documents this path as working and it does not.
2. The same line pairs with [build-plugins.mjs:29](../scripts/build-plugins.mjs), which sets the Codex `SessionStart` matcher to `^(startup|clear)$`. Codex's own `compact` source is excluded deliberately, to avoid double loading through a `PostCompact` that cannot fire usefully. The fix is the reverse: use `^(startup|clear|compact)$` on `SessionStart` and drop `PostCompact` entirely.
3. Both packages emit `"session_key": "${session_id}"` into an `mcp_tool` input at [build-plugins.mjs:23](../scripts/build-plugins.mjs). Codex documents that expansion. Claude Code documents that it does **not** expand `${session_id}` in configuration. If the docs are right, the Claude compact-path load has been keyed on the literal string `${session_id}` this whole time, which would silently break project selection on that path. Marked unverified in section 12 with the exact test that settles it.

**The `Stop` open question is answered, and the design's stated reason was wrong.** [memory-v2.md §12](memory-v2.md) lists "whether a `Stop` hook can inject context for the following turn" as open, and §6.3 says "it probably cannot inject anyway". On Claude Code it can, and the documentation says the context arrives as a system message on the next turn. The conclusion not to prefetch still stands, but only on the surviving argument: the next turn may change topic. That correction goes into the design document.

**The router cannot be a `prompt` hook.** Claude Code has a `prompt` handler type that would run a single-turn LLM evaluation with no code at all. Codex parses and skips it. So the router runs the same way on both hosts or it does not run on one of them.

**Codex's router sees less.** Codex `Stop` has no `last_assistant_message`, and its documentation says outright that "the transcript format isn't a stable interface for hooks and may change over time". So the Codex router gets the user's messages and not the assistant's replies.

### 3.2 The consequence: never read the transcript

Claude Code's transcript "is written asynchronously and may lag the in-memory conversation, so it may not yet include the current turn's most recent messages when a hook fires". Codex's is explicitly not a stable interface. Parsing either one is the wrong foundation.

Both hosts hand the user's exact text to `UserPromptSubmit` before it is sent. So:

```
UserPromptSubmit  ──▶ append the prompt to a session-local ring buffer
                  ──▶ query retrieval with prompt + cached topic terms
                  ──▶ inject

Stop              ──▶ read the ring buffer for this turn
                  ──▶ Claude only: add last_assistant_message
                  ──▶ call the router, write memories, cache topic terms
```

No transcript parsing on either host. The user's own words come from the one field that is documented, exact, and lag-free. This is also the strictest possible reading of [memory-v2.md §4.3](memory-v2.md), which requires `source` to be a span from the user's message in the current turn.

The ring buffer is a file under the host's own scratch space keyed by `session_id`, holding the last N user messages and the cached topic terms. It never leaves the machine except as router input.

---

## 4. Semantic search, proven

### 4.1 What is actually available

PGlite 0.5.8 ships `PostgreSQL 18.3` and these contribs, which is what the existing test suite can exercise:

```
amcheck auto_explain bloom btree_gin btree_gist citext cube dict_int dict_xsyn
earthdistance file_fdw fuzzystrmatch hstore intarray isn lo ltree moddatetime
pageinspect pg_buffercache pg_freespacemap pg_stat_statements pg_surgery
pg_trgm pg_visibility pg_walinspect pgcrypto seg tablefunc tcn
tsm_system_rows tsm_system_time unaccent uuid_ossp
```

`pg_trgm` and `unaccent` are there. **`vector` is not.** So a pgvector design is not testable in the harness this repo already has, while the FTS design is testable today with no new infrastructure. That is a stronger argument for [§5.8](memory-v2.md) than the one currently written, which only says vectors cost more.

### 4.2 `websearch_to_tsquery` is the wrong function, and it fails silently

The obvious implementation ANDs every term in the prompt. Five memories loaded, prompts run through `websearch_to_tsquery('english', $1)`:

```
rank "fix the consent page layout"    [{"id":1,"project":"satchel","score":"0.850"}]
rank "reimbursement rbi rate"         []
rank "ok continue"                    []
rank "ok continue consent paper"      []
rank "razorpay"                       [{"id":3,"project":"reimbursement","score":"0.889"}]
```

Row 3 is `monthly RazorpayX claims are converted at the RBI rate`. The query `reimbursement rbi rate` returns **nothing**, because `reimbursement` is not in the statement and the AND fails. Row 1 is `the consent page has a corner leak on .paper`, and `ok continue consent paper` returns nothing for the same reason.

A prompt is a bag of words, not a boolean expression. Nobody would catch this by reading the code, because the function name says "websearch" and web search is what you think you want.

### 4.3 The fix, and the same probes passing

Convert the prompt to its lexemes and OR them:

```sql
create function or_tsquery(p_text text) returns tsquery
language sql immutable as $$
  select coalesce(
    nullif(array_to_string(tsvector_to_array(to_tsvector('english', p_text)), ' | '), '')::tsquery,
    ''::tsquery)
$$;
```

```
or_tsquery("ok continue consent paper")  [{"q":"'consent' | 'continu' | 'ok' | 'paper'"}]
or_tsquery("reimbursement rbi rate")     [{"q":"'rate' | 'rbi' | 'reimburs'"}]
```

### 4.4 Trigram: `similarity` fails, `word_similarity` works

For a prompt term against a whole sentence, whole-string similarity is near zero:

```
word_similarity razorpay               [{"id":3,"s":"0.89"}]
similarity whole-string razorpay       []
```

So the operator is `<%` with `word_similarity`, not `%` with `similarity`. Both are `pg_trgm`, one character apart in the SQL, and the wrong one returns an empty set rather than an error. This catches morphology that the stemmer misses, like `razorpay` against `RazorpayX`.

### 4.5 The full ranking query, with output

```sql
with q as (select or_tsquery($1) tsq, $1 raw)
select m.id, m.project,
  greatest(ts_rank_cd(m.search, q.tsq), word_similarity(q.raw, m.statement))
   * case when m.project = any($2::text[]) then 3.0    -- touched this session
          when m.project = any($3::text[]) then 2.0    -- linked to this repo
          else 1.0 end
   * case when m.task_closed then 0.7 else 1.0 end     -- demote, never exclude
  as score
from memories m, q
where (q.tsq <> ''::tsquery and m.search @@ q.tsq) or q.raw <% m.statement
order by score desc limit 5
```

Run against the five rows, with `satchel` linked to the repo:

```
rank "fix the consent page layout"       [{"id":1,"project":"satchel","score":"0.850"}]
rank "reimbursement rbi rate"            [{"id":3,"project":"reimbursement","score":"0.381"}]
rank "ok continue"                       []
rank "ok continue consent paper"         [{"id":1,"project":"satchel","score":"0.609"}]
rank "can you write up the plan"         []
rank "razorpay"                          [{"id":3,"project":"reimbursement","score":"0.889"}]
rank "consent page" +satchel touched     [{"id":1,"project":"satchel","score":"1.275"}]
```

Four of these are load-bearing evidence for decisions the design already made on argument alone:

| Probe | What it proves |
|---|---|
| `"can you write up the plan"` returns nothing, while `never propose a development timeline unless it is in scope` sits in the table | [§5.2](memory-v2.md) is right. A standing writing rule is unreachable by retrieval. Personal memory has to be always-loaded, and this is why it is not a setting. |
| `"ok continue"` returns nothing | The `Stop` hook's cached topic terms are load-bearing, not a nicety. Without them a continuation prompt retrieves zero. |
| `"ok continue consent paper"` returns row 1 at 0.609 | And with them it works. The mechanism in [§6.3](memory-v2.md) is the fix for the row above it. |
| `0.850` becomes `1.275` when `satchel` moves from linked to touched | The [§5.4](memory-v2.md) boost multiplies as specified, in SQL, with no extra round trip. |

### 4.6 Measured against a corpus I did not write

Everything above is five rows I wrote myself, which proves the SQL runs and proves nothing about whether retrieval is any good. So a separate agent generated a corpus with no knowledge of the query design: one person's accumulated context across 17 projects, 99 tasks, **413 memories** and **75 realistic prompts**. Domains run from a Go payments ledger to sourdough, knee rehab, a Schengen visa and a wedding. The prompts were written as things a person would type, not as queries designed to hit anything.

**Result 1. The AND form is not slightly wrong, it is unusable.**

```
strategy                   hit%   zero   avg@5   by context (cold/mid/follow)
A websearch AND (english)    5%     71    0.13   4% / 8% / 6%
B or-lexemes (english)     100%      0    4.85   100% / 100% / 100%
C or-lexemes (simple)      100%      0    4.95   100% / 100% / 100%
D B + word_similarity      100%      0    4.97   100% / 100% / 100%
```

71 of 75 prompts return nothing under `websearch_to_tsquery`. Section 4.2 caught this on three hand-made rows. At corpus scale it is a 5% hit rate.

**Result 2. But 100% is the opposite failure, and `ts_rank_cd` cannot fix it.**

Over all returned rows the rank is nearly binary:

```
364 returned rows; rank percentiles  p10 0.1000  p25 0.1000  p50 0.1000  p75 0.2000  p90 0.2000  max 0.5000
```

One matched lexeme scores 0.1, two score 0.2, and no floor separates signal from noise. The consequence, unedited:

```
"go on"
   0.2000  [cardinal-ledger] Cardinal is a Go service and the team agreed to stay on Go 1.23...
   0.1000  [personal] Full legal name on documents is spelled with a single r in the middle...
```

`ts_rank_cd` has no corpus statistics, so a match on `go` outranks everything. A vague continuation returns five confident-looking rows of pure noise. Shipping section 4.5 as written would inject that on every "ok keep going".

**Result 3. Inverse document frequency fixes ranking.**

Score a row by the summed IDF of the query lexemes it contains, using `ts_stat` over the same generated column:

```sql
create materialized view lexeme_df as
  select word lex, ndoc from ts_stat('select s from public.memories');
```

```
"remind me why we cant get rid of that old payout table yet"
     8.49  [cardinal-ledger] The legacy payouts_v1 table cannot be dropped until finance signs off...
     8.49  [cardinal-ledger] The backfill from payouts_v1 to the new table finished in April...

"how much am i short on my section 80C this year"
     8.06  [tax-fy26] The 80C gap this year is about 42,000 rupees after EPF and the term insurance...
     8.06  [tax-fy26] Prefers ELSS over PPF for the 80C top up because of the three year lock in...
```

Exactly right, at rank one and two, out of 413.

**Result 4. Ranking is settled. The floor is not, and I got this wrong once already.**

A sum rewards long prompts, so it cannot also serve as the floor. My first answer was a **rarity gate**: admit a row only if it matched a term that is rare in the corpus. It silences vague prompts nicely.

It also throws away correct answers. `"remind me why we cant get rid of that old payout table yet"` returns the two `payouts_v1` memories at 8.49, first and second out of 413. Under a rarity gate of 4.6 it returns **nothing**, because `payout` and `table` are each individually common in this corpus and only their combination is specific.

Four candidate floors, all measured:

```
rule                   hits   avg-rows   vague-leak   payout   80C
A best >= 4.6          67/75       3.21         1/3   silent   right
B total >= 7           34/75       0.84         0/3   right    right
C coverage >= 0.35     56/75       1.93         3/3   right    silent
D A or C               75/75       4.07         3/3   right    right
```

- **A** silences vague prompts and loses the payout answer.
- **B** is the only rule that gets both benchmarks and leaks no vague prompt, at a third of the coverage.
- **C and D** are broken by short prompts. `"go on"` carries a total information ceiling of 3.9, so matching `go` alone is 100% coverage and any ratio rule waves it through. Normalising by query length fails exactly where the floor matters most.

**None of these is the answer.** The corpus has since been labelled and the floor measured properly, in 4.8. The short version: no threshold on a lexical score separates "no answer" from "found it" well enough to use, and a cosine threshold does. This whole subsection is kept because the reasoning is still how you would approach it if vectors were not available.

For the record, at rule A the vague prompts do go quiet, which is the behaviour the design wants:

```
"go on"                        (nothing)
"ok keep going"                (nothing)
"what was i doing last week"   (nothing)
```

`"what was i doing last week"` returning nothing is right rather than a miss: [§5.5](memory-v2.md) routes that to `list_tasks`. One false positive survives every rule: `"shorter"` matches a sourdough memory about a "shorter bulk".

**Result 5. The paraphrase miss is now a specific case, not a hypothetical.**

```
"what was the deal with the double-charge thing we hit on capture"
     5.3  [cardinal-ledger] p99 on the capture endpoint should stay under 180ms...
     5.3  [cardinal-ledger] Partial refunds must never let the total refunded exceed...
```

The corpus does contain the answer:

```
[cardinal-ledger] Idempotency keys should be scoped to merchant plus key, not global...
[cardinal-ledger] Concurrent requests with the same idempotency key should return 409...
```

The user said **double-charge**. The memory says **idempotency**. Zero lexical overlap, so no amount of FTS tuning reaches it. This is the failure embeddings exist for.

[memory-v2.md §11](memory-v2.md) defers pgvector until "the injection log shows FTS missing things that can be pointed at". That trigger has fired already, before shipping, on a corpus nobody tuned. It does not change the build order, because 67 of 75 is a working product and `vector` is still absent from the test harness. It does move pgvector from "maybe never" to "expected, and the first miss is already written down".

**Result 6. Session start is over the shipped cap by 4.5x.**

```
session start: 76 personal + 17 projects = 8158 chars, ~2147 tokens
```

[§6.1](memory-v2.md) budgets around 1.8k tokens, so the design is roughly right. But [server/mcp-server.mjs:96](../server/mcp-server.mjs) refuses to inject anything over **1,800 bytes**, and this is 8,158. On a corpus this size today's hook injects nothing at all and reports the index incomplete.

**What this adds to the build.**

| Item | Where it lands |
|---|---|
| `lexeme_df` materialized view plus a refresh strategy | migration C. Statistics go stale as memories are written, and refreshing on every write is not viable. Periodic is fine, since IDF does not need to be exact. |
| `m_score(query, vec)` returning `total` and `best` | migration C, replacing `ts_rank_cd` |
| A floor, rule undecided | a third setting. Do not hardcode one until the labelled set exists. |
| Relevance labels over the existing corpus | the one piece of human work that turns the floor from a guess into a measurement |
| The eval harness | committed at [eval/retrieval.mjs](../eval/retrieval.mjs) with [eval/corpus.json](../eval/corpus.json). `node eval/retrieval.mjs`. Not part of `npm test`, because it measures quality and quality is read, not asserted. |

### 4.8 Lexical versus vectors, measured against labels

Three agents independently labelled the 75 prompts against all 413 memories, with no knowledge of any retrieval method. Grade 2 means the assistant would be wrong without it, grade 1 means it would be better with it. They produced **227 grade-2 and 314 grade-1 judgements**, a median of 3 grade-2 per prompt, and agreed that **6 prompts have no correct answer at all**. Those 6 are the ones that decide the floor.

Embeddings come from a local `ollama`, so nothing leaves the machine. Vector search in the bench is exact cosine in JavaScript, which is the upper bound any pgvector index approximates. That measures quality, not operational cost.

**Ranking, ungated:**

```
system                             P@5   R@5    MRR  nDCG@10
lexical (IDF sum)                  0.212 0.405 0.593   0.420
vector all-minilm (384d)           0.290 0.538 0.718   0.534
vector nomic-embed-text (768d)     0.290 0.547 0.701   0.528
hybrid RRF  lex+all-minilm         0.296 0.567 0.728   0.532
hybrid w=0.3 lex+all-minilm        0.310 0.582 0.752   0.555
hybrid w=0.5 lex+all-minilm        0.296 0.550 0.705   0.525
hybrid w=0.3 lex+nomic-embed-text  0.296 0.563 0.748   0.537
```

Vectors beat lexical on every measure. Hybrid at 30% lexical beats both. That ordering was not obvious to me and it is the opposite of what section 4.7 implies.

**The floor, which is what the labels were for:**

```
lexical, floor on summed IDF          vector nomic-embed-text, floor on cosine
floor  covered  silent   R@5          floor  covered  silent   R@5
0        69/69     0/6  0.405         0.50     68/69     1/6  0.544
6        51/69     2/6  0.335         0.55     63/69     5/6  0.486
7        33/69     5/6  0.402         0.60     43/69     6/6  0.552
8        26/69     6/6  0.442         0.65     28/69     6/6  0.558
```

To silence 5 of the 6 answerless prompts, lexical has to throw away half its answerable ones. Cosine at 0.55 silences the same 5 while keeping 63 of 69.

**At matched silence, which is the only fair comparison:**

```
config                               P@5   R@5    MRR  nDCG@10   silence   covered
nomic alone, gate 0.55               0.235 0.444 0.629   0.421      83%     63/69
hybrid w=.3 lex+nomic, gate 0.55     0.235 0.444 0.646   0.427      83%     63/69
hybrid w=.3 lex+mini,  gate 0.55     0.232 0.442 0.657   0.430      83%     61/69
lexical only, gate idf>=7            0.090 0.192 0.360   0.181      83%     33/69
```

Metrics are over all 69 answerable prompts, so staying silent costs a config its score. Silence is not free here.

**Lexical alone is 2.4x worse than hybrid at the same silence rate.** That is the number that settles it.

**Three things I had wrong, and one of them I argued at you directly.**

1. I said vectors do not solve the cutoff problem, they only move it, because cosine thresholds are unstable across query length. Measured on labelled data, cosine separates far more cleanly than a summed IDF does, because IDF sums grow with query length and cosine does not. That was my argument and it was backwards.
2. I was dismissive of Supermemory hardcoding `0.55`. On this corpus with this model, 0.55 is almost exactly the right operating point. Their constant is not the mistake. Shipping a constant without ever measuring it is.
3. I justified FTS-first partly because pgvector is absent from PGlite. That is a testing inconvenience being used as a product argument, and it does not survive a 2.4x quality gap.

**The small model is as good as the big one, and faster.**

| | size | dims | embed latency | best nDCG | thresholds cleanly |
|---|---|---|---|---|---|
| `all-minilm` | 45 MB | 384 | **7.6 ms** | **0.555** hybrid | no, scores compress |
| `nomic-embed-text` | 274 MB | 768 | 40 ms | 0.537 hybrid | **yes**, clean at 0.55 |

Measured on this machine over 488 texts. `all-minilm` ranks slightly better and is five times faster. `nomic` gates far better, and gating is what the product needs. Ranking by either and gating on nomic's cosine differ by 0.003 nDCG, so this is a real choice with a real tradeoff rather than one model dominating.

**What changes in the plan.**

Hybrid is the destination, not a deferred maybe. The build order does not change, because step 7 still ships FTS and FTS still works standalone with no model and no embedding call in front of every prompt. But the framing does: FTS is step one because it is independent, not because it is sufficient. Step 8 adds `vector`, the embedding call, and the cosine gate.

It also has to be pgvector **inside Supabase**, not a separate vector service. The scope multipliers in [§5.4](memory-v2.md) have to be applied inside the ranking, not after it. A separate service can only return top-K on raw similarity, so a memory that ranked 51st but would have won after a 3x touched-project boost is already discarded before the boost can run. One database, one round trip, one set of grants.

### 4.9 Final numbers, with intervals

`node eval/decide.mjs`. Everything below is a paired bootstrap over the 69 answerable prompts, 2000 resamples, 95% intervals.

**Most of the differences I reported are not real.**

```
system                       nDCG@10       95% CI
lexical (IDF sum)             0.420       [0.354, 0.483]
vector all-minilm             0.534       [0.468, 0.594]
vector nomic                  0.528       [0.463, 0.594]
hybrid w=0.2 lex+nomic        0.539       [0.472, 0.600]
hybrid w=0.3 lex+minilm       0.555       [0.492, 0.617]

paired differences
  hybrid w=0.3 lex+nomic - vector nomic             +0.010  [-0.008, 0.029]  NOISE
  hybrid w=0.3 lex+nomic - hybrid w=0.3 lex+minilm  -0.018  [-0.052, 0.013]  NOISE
  vector nomic - vector all-minilm                  -0.006  [-0.040, 0.031]  NOISE
  vector nomic - lexical (IDF sum)                  +0.108  [ 0.057, 0.159]  real
```

One difference survives: **vectors beat lexical.** Hybrid over pure vector, one embedding model over the other, and one fusion weight over another are all inside the noise on 69 prompts. I reported 0.555 against 0.528 as though that meant something. It does not.

That simplifies the build considerably. No fusion, no `lexeme_df` materialized view, no IDF function, no refresh strategy, and no second ranker to keep in sync. One vector index and one score. The lexical work in 4.3 to 4.5 stays valuable as the fallback when no embedding is available, not as half of the production ranker.

**The scope multipliers are far too aggressive, and the big ones buy nothing.**

A boost multiplies a score in [0,1], so it reorders globally rather than nudging. Measured against a session sitting in one repo, once where the boosted project is the one being asked about and once where it is not:

```
mult    right-project   wrong-project    break-even hit rate
1.05           +0.048          -0.010    18% of prompts
1.1            +0.077          -0.022    22% of prompts
1.25           +0.080          -0.116    59% of prompts
1.5            +0.076          -0.333    81% of prompts
2.0            +0.073          -0.493    87% of prompts
3.0            +0.073          -0.508    87% of prompts
```

**1.1 captures the entire benefit of 3.0 and costs a twentieth as much when wrong.** Above 1.25 the gain is flat and only the damage grows. [§5.4](memory-v2.md) specifies 3.0 for a touched project and 2.0 for a linked one, which would need 87% of prompts in a session to be about that project just to break even. On a corpus spanning a payments ledger, sourdough and knee rehab, they are not.

**The closed-task demotion is contradicted by the labels.**

```
memories hanging off a closed task: 8.5% of the corpus, 11.4% of what the labels say is relevant
```

They are *more* likely to be wanted, not less, which makes sense: a task closing does not make what you learned during it irrelevant. The `0.7` in [§5.4](memory-v2.md) should go. The `[task · closed]` annotation from [§6.2](memory-v2.md) stays, because flagging possible staleness is a different thing from ranking lower.

**What to embed: just the statement.**

```
statement+source - statement: +0.015  [-0.011, 0.041]  NOISE
nomic/scoped (project prefix): 0.508, worse than plain statement
```

Prefixing the project name actively hurts. Storing `source` remains right for the audit trail in [§4.3](memory-v2.md), but it does not belong in the index.

**The gate is a dial, and the corpus is too thin to fix its value.**

```
index         gate  limit  nDCG@10  covered  silent  median rows
statement     0.50    5      0.472    68/69     1/6            5
statement     0.55    5      0.412    63/69     5/6            3
statement     0.60    5      0.310    43/69     6/6            1
stmt+source   0.50    5      0.502    67/69     1/6            5
stmt+source   0.55    5      0.467    65/69     3/6            5
```

Coverage and silence trade against each other smoothly, which is the behaviour you want from a threshold. But **silence is measured on six prompts**, and no constant should be fixed on six samples. Getting that number right needs more answerless prompts in the corpus, which is cheap to add and is the single most useful thing to do to this eval next.

Given that, I would ship the looser end. An extra row the agent ignores costs a few tokens; a missing row costs the answer, and [§6.2](memory-v2.md)'s counts line already tells the agent how much it is looking at.

**The recommendation, measured end to end:**

```
nomic-embed-text over statement, cosine gate 0.55, cap 5, 1.1 boost on the in-repo project
nDCG@10 0.523 [0.458, 0.589]   covered 67/69   silent 3/6
```

One model, one index, one score, one threshold, one small boost. No fusion and no IDF.

**Cost, measured on this machine.** `all-minilm` embeds a text in 7.6 ms and `nomic-embed-text` in 40 ms, both locally through ollama with nothing leaving the machine. Since the two are statistically indistinguishable on ranking, and `nomic` only won on gating with a threshold the corpus cannot yet pin down, `all-minilm` at 45 MB and 7.6 ms is the one I would start with and re-measure.

### 4.10 Remaining search decisions

- **Dictionary.** `english` stems `continue` to `continu` and drops stopwords. For a corpus with product names and slugs in it, `simple` keeps more and stems nothing. Probe both against a real corpus before fixing it, and store the choice in the generated column so it is one migration to change.
- **`unaccent`.** Available. Not needed on day one.
- **Rank function.** `ts_rank_cd` rewards proximity; `ts_rank` does not. Using `cd` because prompts are short.
- **Combining the two signals.** `greatest()` is the cheap choice and it means a strong trigram hit can outrank a weak FTS hit. A weighted sum is the alternative. Tune against the log, not in advance.
- **The floor rule.** Gate on cosine, per 4.8. The exact value is not settled and should not be, per 4.9: it rests on six answerless prompts. Add more before fixing a constant.
- **Index.** GIN on the generated `tsvector`, plus GIN `gin_trgm_ops` on `statement`. Both were created and used in the probes.

---

## 5. Backend work

### 5.1 Migration A, the memory shape

```sql
alter table public.memories
  add column statement text,
  add column source    text,
  add column band      text not null default 'said'
    check (band in ('said','heard')),
  add column task_id   uuid;

update public.memories set statement = description, source = description;

alter table public.memories
  alter column statement set not null,
  add constraint memories_statement_check
    check (length(btrim(statement)) between 1 and 500),
  drop column description;

alter table public.memories alter column name drop not null;
drop index memories_scope_name;
drop index memories_personal_name;
create unique index memories_scope_name on public.memories(owner_id, project_id, lower(btrim(name)))
  where name is not null;
create unique index memories_personal_name on public.memories(owner_id, lower(btrim(name)))
  where project_id is null and name is not null;

grant insert(statement, source, band, task_id) on public.memories to authenticated;
grant update(statement, source, band, task_id) on public.memories to authenticated;
```

Details that will bite otherwise:

- Both unique indexes must become partial. Without `where name is not null`, the second unnamed memory fails on a NULL collision in the personal index.
- The column grants are not optional. Section 2.1.
- `task_id` cannot be a plain FK to `tasks(id)`, because `tasks` is keyed `primary key (owner_id, id)` and scoped by a generated `scope_key`. The correct reference is `(owner_id, scope_key, id)`, so `memories` needs its own matching generated `scope_key` and a composite FK. Otherwise a memory can point at a task in a different scope.
- `band` defaults to `said` so every existing row, all of which were explicitly saved, is correct without a backfill.

### 5.2 Migration B, slugs

```sql
alter table public.projects add column slug text;
alter table public.tasks    add column slug text;
-- backfill with slugify(), then:
alter table public.projects alter column slug set not null,
  add constraint projects_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 40);
alter table public.tasks alter column slug set not null,
  add constraint tasks_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 40);
create unique index projects_owner_slug on public.projects(owner_id, slug);
create unique index tasks_owner_slug    on public.tasks(owner_id, slug);
```

Unique per user, not per project, per [§4.4](memory-v2.md). `slugify()` exists only to backfill, and collisions during backfill get a numeric suffix. `create_task` and `upsert_project` gain a required `p_slug` and raise `23505` on collision, which [server/mcp-server.mjs:59](../server/mcp-server.mjs) already maps to a sensible message.

### 5.3 Migration C, search

```sql
create extension if not exists pg_trgm;

alter table public.memories add column search tsvector
  generated always as (to_tsvector('english', statement)) stored;
create index memories_search      on public.memories using gin(search);
create index memories_statement_trgm on public.memories using gin(statement gin_trgm_ops);
```

A generated column means no trigger, no write cost in application code, and no way for the index to drift from the text. Proven working on 18.3 in section 4.

Then the retrieval function, `security invoker` so RLS stays authoritative exactly like every existing function:

```
search_memories(p_query text, p_touched uuid[], p_limit int, p_exclude uuid[])
  returns table(id, project_id, statement, band, task_id, task_slug, task_status,
                task_closed_at, score, total_matched, total_in_scope)
```

`total_matched` and `total_in_scope` are what produce the counts line in [§6.2](memory-v2.md), and they are the thing that lets the agent tell "no rule about this" from "nothing scored". They are two window functions over the same scan, not two extra queries.

Repo-linked projects come from the existing `project_repositories` table, so the 2.0 boost is a join, not a parameter.

### 5.4 Migration D, settings and the log

```sql
create table public.memory_settings (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  per_prompt_matches int not null default 5 check (per_prompt_matches between 0 and 20),
  session_budget_tokens int not null default 15000 check (session_budget_tokens between 1000 and 60000)
);

create table public.memory_injections (
  id uuid primary key, owner_id uuid not null, session_key text not null,
  event text not null check (event in ('SessionStart','UserPromptSubmit')),
  query text, memory_ids uuid[] not null default '{}',
  matched int not null, in_scope int not null, tokens int not null,
  created_at timestamptz not null default now()
);
```

Two settings, per [§8](memory-v2.md). The log is not analytics. It is the evidence that decides pgvector, decides the pin, and answers "why did it not know that". Without it every deferred item in [§11](memory-v2.md) has no trigger and stays deferred forever.

Settings are read in the same call that fetches the index, so no extra round trip.

### 5.5 The router service

The router is the only new moving part and the only one that leaves the machine.

**Where it runs is a real decision with a privacy consequence, and the design has not made it.** [§12](memory-v2.md) lists the model choice as open but not the placement. Placement matters more:

| Placement | Consequence |
|---|---|
| In the hook, on the user's machine | Needs an API key on every machine. Satchel never sees conversation text. Consistent with every existing promise. |
| On the Satchel server | One key, one place to rotate, one place to log. But Satchel now receives rolling windows of real conversation. |

The second option contradicts text Satchel currently ships. [integrations/shared/bootstrap.mjs:44](../integrations/shared/bootstrap.mjs) tells the agent "Never read host credentials, collect transcripts, or write memory automatically", and [docs/memory-hooks.md](memory-hooks.md) says "No transcript or prompt is a tool argument". Sending turn windows to `/api/router` makes both statements false. That is not a reason it cannot be done. It is a reason it cannot be done quietly.

My recommendation is server side with the promise rewritten honestly, because a per-machine API key will not survive contact with the phone, the companion, or a second laptop. Whichever way it goes, it needs:

- Zero data retention on the provider, non negotiable, since the input is real conversation.
- A hard cap on input size and a short timeout. The router failing means nothing is captured, which is exactly today's behaviour, so it must fail open and silent.
- The full prompt and the full response logged to `memory_injections`' sibling table, because a capture you cannot explain is worse than no capture.

The contract is fixed by [§4.2](memory-v2.md): `[ { statement, source, project?, task? } ]`, with an empty list as the "no". Resolution from slug to UUID happens in the hook or the endpoint, never in the model, per [§4.5](memory-v2.md).

### 5.6 New HTTP surface

`api/` currently has exactly three files. This adds two:

| Endpoint | Auth | Does |
|---|---|---|
| `POST /api/router` | agent OAuth token | turn window in, memory rows written, topic terms returned |
| existing `/api/mcp` | unchanged | gains the tools in section 6 |

The `UserPromptSubmit` retrieval goes through MCP as an `mcp_tool` hook, not a new endpoint, because it needs the same grant checks everything else has and `mcp_tool` is the one handler type both hosts support.

---

## 6. MCP tool changes

| Tool | Change | Why |
|---|---|---|
| `load_memory_context` | rewritten output per [§6.1](memory-v2.md); byte budget becomes the setting | it currently returns raw JSON and caps at 1,800 bytes |
| `retrieve_memory` | **new.** query plus session key, returns ranked rows and the counts | the per-prompt hook target |
| `memory_index` | becomes a scoped search with a `query` argument | [§10](memory-v2.md) |
| `read_memory` | unchanged, but only reachable for rows flagged as having `more_info` | most rows will not have it |
| `save_memory` | `name` optional, `description` becomes `statement`, writes `band='said'` | explicit saves bypass the router |
| `correct_memory` | same rename, and accepts the six-char handle | |
| `delete_memory` | accepts the six-char handle | the injected block shows handles, not UUIDs |
| `confirm_memory` | **new.** promotes `heard` to `said` | [§9](memory-v2.md) |
| `create_task` | required `slug` | [§4.4](memory-v2.md) |
| `upsert_project` | required `slug` | |
| `list_projects`, `list_tasks` | return `slug` | the router's system prompt is built from these |
| `record_router_capture` | **new**, or folded into `/api/router` | |

The six-character handle is a prefix of the UUID. It needs a server-side resolver that raises on an ambiguous prefix rather than picking one, and the handle length should grow automatically if a user ever has a collision.

`lifecycle=z.enum(['SessionStart','PostCompact'])` at [server/mcp-server.mjs:10](../server/mcp-server.mjs) gains `UserPromptSubmit` and `Stop`.

---

## 7. Hooks and packaging, per host

### 7.1 Claude Code

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "^(startup|clear|compact|resume)$",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs\"", "timeout": 5 }] },
      { "matcher": "^(startup|clear|compact|resume)$",
        "hooks": [{ "type": "mcp_tool", "server": "plugin:satchel:satchel", "tool": "load_memory_context", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/recall.mjs\"", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/capture.mjs\"", "timeout": 30, "async": true }] }
    ]
  }
}
```

- `resume` is added. Today both packages exclude it and [docs/memory-hooks.md](memory-hooks.md) records that as deliberate, because reloading a whole index onto a resumed session duplicated it. With retrieval, resume is the case that needs the projects and personal block most, since the session may be days old.
- `UserPromptSubmit` gets a 5s timeout against a documented 30s default, because a hook that delays the prompt is worse than a hook that misses.
- `Stop` is `async: true`. Claude Code does not enforce a timeout on async command hooks, and capture must never hold up the turn.
- `Stop` is a `command`, not an `mcp_tool`, because it needs the session ring buffer from disk and `last_assistant_message` from stdin before it calls anything.
- The `mcp_tool` input no longer hardcodes `${session_id}`. See section 12.

### 7.2 Codex

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "^(startup|clear|compact|resume)$",
        "hooks": [{ "type": "command", "command": "node \"${PLUGIN_ROOT}/scripts/bootstrap.mjs\"", "timeout": 5 }] },
      { "matcher": "^(startup|clear|compact|resume)$",
        "hooks": [{ "type": "mcp_tool", "server": "satchel", "tool": "load_memory_context",
                    "input": { "session_key": "${session_id}", "event": "SessionStart" },
                    "timeout": 10, "additionalContextLimit": 6000 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"${PLUGIN_ROOT}/scripts/recall.mjs\"", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"${PLUGIN_ROOT}/scripts/capture.mjs\"", "timeout": 30, "async": true }] }
    ]
  }
}
```

- `PostCompact` is **deleted**. It cannot emit `additionalContext`, so it has never worked. `compact` moves into the `SessionStart` matcher, which is where Codex puts it.
- `additionalContextLimit` is raised from its 2500-token default, since [§6.1](memory-v2.md) budgets around 1.8k and a user with many personal memories will exceed the default and get a truncated preview pointing at a temp file.
- Codex `Stop` cannot inject, which is fine, because capture does not inject. It writes memories and caches terms.
- Codex `Stop` has no `last_assistant_message`, so the Codex router runs on user messages only. Stated degradation, not a bug to chase.

### 7.3 The three new scripts

All three go in `integrations/shared/` and are copied into both packages by [scripts/build-plugins.mjs](../scripts/build-plugins.mjs), exactly as `bootstrap.mjs` is today.

| Script | Reads | Writes | Fails by |
|---|---|---|---|
| `bootstrap.mjs` | stdin, git remote | repository hint | existing behaviour, unchanged except the event allowlist |
| `recall.mjs` | stdin `prompt`, ring buffer, cached terms | injects the block | printing nothing |
| `capture.mjs` | stdin, ring buffer, `last_assistant_message` on Claude | calls the router, caches terms | printing nothing |

`recall.mjs` needs a token to call Satchel, and the plugin has no credential of its own. It either shells out to the host's MCP connection, which command hooks cannot do, or the retrieval moves to an `mcp_tool` hook and the ring buffer append becomes a second, cheap `command` hook on the same event. **The second shape is the one that works**, so `UserPromptSubmit` gets two handlers: a `command` that appends the prompt locally, and an `mcp_tool` that retrieves and injects. That also keeps every authenticated call on the one transport that already has grants and audit.

### 7.4 What both bootstraps must stop saying

[integrations/shared/bootstrap.mjs:46](../integrations/shared/bootstrap.mjs) currently instructs the agent: "do not repeat index checks, refreshes, or fallback attempts on ordinary messages. Refresh only on a new-conversation/compaction event". That text exists to enforce the no-per-prompt decision that v2 reverses. It has to change in the same commit as the hook, or the model will be told to ignore the thing the hook just injected.

---

## 8. Web app work

`src/` is 11 files and about 850 lines. The changes are proportionate.

### 8.1 Existing screens

| File | Change |
|---|---|
| [features/memories/model.ts](../src/features/memories/model.ts) | `MemoryContent` becomes `{ statement, source, band, task_id, name?, more_info? }`; `MEMORY_LIMITS.statement = 500` |
| [features/memories/MemoryEditor.tsx](../src/features/memories/MemoryEditor.tsx) | name becomes optional and secondary, description becomes the single required statement field, `more_info` collapses behind a disclosure |
| [features/memories/MemoryList.tsx](../src/features/memories/MemoryList.tsx) | show the handle, the band, and the task link; a `heard` row gets a **Confirm** button that is the whole promotion mechanism from [§9](memory-v2.md) |
| [features/memories/repository.ts](../src/features/memories/repository.ts) | rename through, add `confirm`, add `search` |
| [features/projects/ScopeSidebar.tsx](../src/features/projects/ScopeSidebar.tsx) | slug field on project create, shown next to the name |
| [features/tasks/TaskWorkspace.tsx](../src/features/tasks/TaskWorkspace.tsx) | slug field on task create |
| [Workspace.tsx](../src/Workspace.tsx) | a search box, because with automatic capture the list gets long enough that alphabetical browsing stops working |

A `heard` row needs to look different at a glance. That is the entire user-facing payoff of the band: you can see what the system picked up on its own and disagree with it in one click.

### 8.2 The context panel, which is new

[§8](memory-v2.md) specifies it and [product.md](product.md) section 8 already asked for it. It is a new view alongside memory, tasks and connections in [src/main.tsx](../src/main.tsx).

```
What Claude Code sees in this session

  projects              20 rows     400 tok
  personal              38 rows   1,340 tok
  ─────────────────────────────────────────
  session start                   1,740 tok

  per prompt            last 10   ~240 avg, falling
  ─────────────────────────────────────────
  today                           4,100 tok      [ preview ]
```

Two things make it honest rather than decorative:

- **Preview renders the exact bytes.** It calls the same formatter the hook calls, server side, and prints the result. Not a description of it. That means the formatter has to be a pure function the API can expose, which is a small constraint worth accepting early.
- **Every injection is a row**, with the query that caused it. This is the screen that answers "why did it say that" and it is the same data that triggers or kills pgvector.

### 8.3 Two smaller additions

- A settings screen for the two settings in 5.4. Small.
- Connections gains a line showing whether automatic capture is on for that connection, since a read-only grant cannot capture and the user should be able to see that rather than wonder.

---

## 9. Testing

The suite is 68 assertions across 10 files, all `node --test`, using PGlite for anything touching SQL. Same shape for all of this.

| New file | Covers |
|---|---|
| `tests/memory-shape.test.mjs` | migration A: partial unique indexes admit many NULL names, column grants, band constraint, composite task FK refuses a cross-scope task |
| `tests/slugs.test.mjs` | format constraint, uniqueness per user, two users may share a slug, backfill collisions, `23505` on create |
| `tests/search.test.mjs` | the section 4 probes as assertions: OR-of-lexemes beats `websearch_to_tsquery`, `word_similarity` matches where `similarity` does not, boosts multiply in the documented order, counts are correct, exclusion list works |
| `tests/injection-format.test.mjs` | the formatter is pure and its output is byte-identical to what the preview renders |
| `tests/router-contract.test.mjs` | schema validation, empty list is the no, unknown slug falls back to personal, a `task` whose project disagrees is rejected |

Changed:

- `tests/plugin-bootstrap.test.mjs:60` flips from asserting `UserPromptSubmit` is absent to asserting both handlers exist on both hosts, that Codex has no `PostCompact`, and that both `SessionStart` matchers include `compact` and `resume`.
- `tests/mcp.test.mjs` grows the new tools.

**And one thing the suite cannot do.** Assertions prove the SQL does what it says. They cannot prove retrieval is good, because I write both the rows and the query. That needs the corpus and the eval harness from section 4.6, run by hand and read by a person. It found four problems no unit test would have caught, including one that would have shipped a 5% hit rate.

So `tests/search.test.mjs` should lock the *mechanisms* the eval found, not the scores: OR-of-lexemes over AND, IDF sum over `ts_rank_cd`, the rarity gate rejecting a lone common term, and `word_similarity` over `similarity`. Scores move with the corpus. The mechanisms should not regress quietly.

---

## 10. Build order

Each step is shippable and each one is useful if the next never happens.

| # | Step | Depends on | Useful alone because |
|---|---|---|---|
| 1 | One sentence in `SKILL.md` about unconfirmed memories | nothing | a shaky note and a hard decision stop looking identical |
| 2 | Fix the Codex compaction defect: drop `PostCompact`, add `compact` to `SessionStart` | nothing | a shipped path that does not work starts working |
| 3 | Verify or fix `${session_id}` on Claude `mcp_tool` | nothing | section 12 |
| 4 | Migration B, slugs, plus tool arguments and UI fields | nothing | "resume fix-arch-concern" beats pasting a UUID |
| 5 | Migration A, the memory shape | 4 for `task_id` | the editor gets simpler immediately |
| 6 | Rewrite `load_memory_context` output per §6.1, budget becomes a setting | 5 | fixes the 1,800-byte cliff |
| 7 | Migration C plus `retrieve_memory`, and the `UserPromptSubmit` hooks. Includes `lexeme_df`, `m_score` and the rarity gate from 4.6, not `ts_rank_cd` | 5, 6 | retrieval works against explicitly saved memories, with no router at all |
| 8 | Migration D, settings and the injection log | 7 | nothing after this has a trigger without it |
| 9 | The router, the `/api/router` endpoint, `capture.mjs`, topic-term caching | 7, 8 | this is the actual feature |
| 10 | The context panel | 8 | this is what proves any of the above works |

Step 7 before step 9 is deliberate. Retrieval against a hand-saved corpus is testable, reversible, and it exercises every piece the router will later feed. Shipping capture first would mean debugging retrieval and capture at the same time, against rows a model wrote.

---

## 11. Corrections owed to [memory-v2.md](memory-v2.md)

| Section | Currently says | Should say |
|---|---|---|
| §6.3 | prefetching at `Stop` "probably cannot inject anyway" | on Claude Code it can, and the docs say it lands as a system message next turn. The decision stands on topic-change alone. |
| §12 | whether `Stop` can inject is open | answered. Claude yes, Codex no. Replace with the placement question from 5.5. |
| §5.8 | FTS because vectors cost more | also because `vector` is absent from PGlite, so a vector design is untestable in the harness that exists |
| §6 hooks table | implies both hosts behave alike | needs the asymmetry table from section 3 |
| §12 | does not mention router placement | it is the bigger open question, because it changes what Satchel promises about transcripts |
| §11 deferred table | pgvector waits until "the injection log shows FTS missing things that can be pointed at" | vectors are the destination, per 4.8 and 4.9. Lexical alone is 2.4x worse at matched silence. Hybrid is not justified: it is inside the noise against pure vector. |
| §5.4 multipliers | 3.0 touched, 2.0 linked, 0.7 closed task | about 1.1, and no closed-task demotion. 4.9 measures 3.0 as needing an 87% hit rate to break even while buying nothing over 1.1, and the labels say closed-task memories are more relevant than average, not less. |
| §8 settings | two settings | three. The rarity gate needs to be tunable or derived from corpus size. |

---

## 12. Unverified, with the test that settles each

| Question | Why it matters | How to settle it |
|---|---|---|
| Does Claude Code expand `${session_id}` inside an `mcp_tool` hook `input`? | Docs say no. If so, every Claude compact-path load since [build-plugins.mjs:23](../scripts/build-plugins.mjs) shipped has passed the literal string as `session_key`, and project selection on that path never worked. | Log the received `session_key` in `load_memory_context`, run `/compact` in Claude Code, read the row. Ten minutes. |
| Is [openai/codex#45999](https://github.com/openai/codex/issues/45999) present in the installed Codex? | If `SessionStart` rejects `additionalContext` on this version, the primary Codex injection path is dead and the fallback is `systemMessage`. | Minimal hook returning `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"x"}}`, start a session, see whether it reports failure. |
| Does an `mcp_tool` hook result reach the model as `additionalContext` on both hosts, or only a `command` hook's stdout? | The whole retrieval path in 7.3 depends on it. The current `SessionStart` `mcp_tool` hook suggests yes on both, but that is inference from our own code working, not a documented guarantee. | Same probe, both hosts, one `command` and one `mcp_tool` side by side. |
| Does Codex's `UserPromptSubmit` fire on the first message of a session, before or after `SessionStart`? | Ordering decides whether the first prompt can be retrieved against. | Two hooks that append timestamps to a file. |
| Real per-prompt latency for `retrieve_memory` over Vercel to Supabase | [§5.7](memory-v2.md) budgets ~100ms against Supermemory's 4s. Vercel cold starts are the risk, not Postgres. | Time it against a seeded database before committing to a 500ms timeout. |
| Whether `all-minilm` or `nomic-embed-text` is the right model | 4.9 says the ranking difference is noise, so it comes down to the gate, which rests on six prompts. | Add answerless prompts to the corpus, then rerun `eval/decide.mjs`. |
| Where the embedding call runs on the read path | It sits in front of every `UserPromptSubmit`. 7.6 ms local is fine; a network call is not. | Same decision as router placement in 5.5, and it should be made once for both. |

Nothing in section 10 is blocked on these except step 3, which is the test itself.
