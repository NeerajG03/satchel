# Memory v2.5: scope

Status: agreed, and most of it is built. Where a requirement says **built**, the
commit is named. Three things are not built and each is blocked on a decision
that is not mine, listed at the end.

| | |
| --- | --- |
| built | R1 through R11, apart from R6's decay curve |
| not built | R6's decay curve, which needs a number nobody has measured yet |
| not switched on | consolidation runs only when `memory_settings.capture_mode` is `session`, and nothing calls `/api/consolidate` on a schedule yet |

The last row is the one to read twice. Everything works and nothing has
changed for anyone, because the default is still the turn-by-turn router.

## What this is

A rebuild of how Satchel decides what to remember, structured so that **supermemory
is the baseline we measure against rather than the thing we read about**.

Three changes, in dependency order:

1. **Documents.** Every conversation turn is kept as raw material, separately from
   the memories derived from it.
2. **Consolidation.** A background pass reads a document together with what is
   already remembered, and emits changes to the memory set rather than inserts.
3. **A bounded block.** What loads into an agent's context is a small, capped,
   curated set. Everything else is archive.

Plus one supporting requirement that makes the rest testable: **the whole system
runs locally in containers**, so a head to head against a self hosted supermemory
is a command rather than a project.

## Why

Not from reading. From the eight rows in production on 21 September 2026.

```
8 memories total.  3 clean.                       precision 37%
5 of 5 auto-captured rows had no embedding        invisible to retrieval
~6 of 12 captured rows were deleted by hand       the user is the cleanup pass
2 stale rows, both `said`, both made false        by our own commits, not by
  by migrations and commits last week             anything anyone said
11 rows retrieved in two days                     the vector stack earns little
0 dropped across 100 router runs                  validate() has never fired
```

Four findings follow from that, and each one points at a requirement below.

**The missing embedding was a one line bug.** `save()` and `correct()` called
`embedRow`; `captureMemory` did not. Fixed in `eed9916`. It is listed here only
because it explains why the failure looked like bad extraction for weeks: capture
is the only writer nobody checks afterwards.

**Capture is a one shot, final, unrecoverable write.** The source it read is
deleted after 24 hours, so a better prompt can never improve a past conversation.
This is the single largest structural problem and requirement R1 exists for it.

**Nothing ever revisits a memory.** There is no supersede, no expiry, no review,
no history. A memory dies only when a human deletes one, which is exactly what the
deletion count shows happening.

**A `heard` memory loads at full strength forever.** Personal memories load whole
at session start, `heard` included, with no down weighting. So one bad capture is
not one bad row, it is permanent context pollution in every future session.

## What "our baseline is supermemory" means

It is a claim we should only make with a number behind it. Operationally:

> Given the same documents, Satchel's memory set is at least as good as the one a
> self hosted supermemory produces from the same input, judged by the same rubric,
> with both running on the same model.

Both sides run on Gemini. Supermemory's hosted platform uses proprietary extraction
models that its free self hosted edition does not include, so this compares
pipelines rather than models. That is the honest comparison and it is also the only
one we can run.

The rubric is the one already used on the eight rows:

| judgement | meaning |
| --- | --- |
| keep | you would defend this row out loud |
| junk | a work order, a one off instruction, or noise |
| stale | was true, is not now |
| missed | durable and said, and neither system captured it |

Acceptance is in the last section.

## Requirements

Each row is either **match** (we should do what supermemory does), **skip** (a
deliberate decision not to), or **exceed** (something we have that it does not, and
which must not regress).

### R1 Documents, and re-derivation

| | |
| --- | --- |
| supermemory | documents and memories are separate nouns; documents are kept and re-dreamed |
| today | `session_messages`, trimmed to 10 rows and deleted after 24 hours |
| decision | **match** |
| status | **built**, `2ceceb5`. `documents` and `document_turns`, both hooks writing through one `record_turn`, the user's half awaited, 30 days and `expire_documents()` with a row count |

A document is the durable record of what was said. Memories are derived from it and
can be derived again. Re-running extraction over stored documents after a prompt
change must produce an updated memory set without any conversation being replayed.

`session_messages` stays as the short working window. It is a different thing with a
different lifetime and it should not be conflated with the document store.

**A document is written by two hooks, not one.** The split is forced by what the
hosts hand us and it is not negotiable:

| hook | endpoint | given | writes |
| --- | --- | --- | --- |
| `UserPromptSubmit` | `/api/hook-retrieve` | `prompt`, truncated to 4000 chars | the user's half |
| `Stop` | `/api/hook-capture` | `assistant`, the host's `last_assistant_message` | the assistant's half |

Stop is never handed the prompt. The only alternative is reading the transcript from
disk, which 0.3.2 deleted on purpose and which the memory skill lists as a rule.

Both roles go in the document, because the assistant's half is what makes "yes, do
that one" interpretable. Only the user's words may supply a memory's source. That
separation already exists in `capture()`, where `context` carries both roles and
`turn` is filtered to user messages, and it survives unchanged.

**The user's write must become awaited.** Today `lifecycle.mjs` fires it with `void`
and does not wait:

```js
if (settings.capture)
  void service.recordSessionMessage(sessionKey, 'user', prompt, settings.capture_window * 2);
```

A Vercel function freezes when it responds, so that promise can be killed mid flight.
For a 24 hour rolling window that is a fair trade against the 5 second budget on a
hook that must not delay the prompt. For a durable record it is not, and it fails in
the worst direction: the user's half is the only half that can supply a source, so
losing it does not degrade a document, it voids it.

On Codex there is no `last_assistant_message`, so a Codex document is user messages
only. Already a stated degradation elsewhere, repeated here because it caps how good
Codex extraction can get.

**Open decision: retention.** See the last section. Answered: 30 days, then delete.

### R2 Consolidation, not insertion

| | |
| --- | --- |
| supermemory | "dreaming", async, `dynamic` groups related documents into coherent units; `instant` processes one document alone and bills extra |
| mem0 | one call that is given the top 10 existing memories, relabelled as integers to stop id hallucination |
| today | one model call per Stop, blind to everything already stored, output is always an INSERT |
| decision | **match, with mem0's relabelling** |
| status | **built**, `fd5337c` and `61cf35f`. `server/consolidator.mjs` asks, `server/consolidation.mjs` applies, `/api/consolidate` runs it. A fifth outcome, `affirm`, was added in `28aeff2` |

The pass is given the document and the current memory set for that scope. Per
candidate it returns one of:

```
add          a new memory
extends #k   enrich an existing one, both stay valid
replaces #k  an existing one is now false
retires #k   an existing intent has been fulfilled
nothing
```

`retires` is the one nothing currently does, and it is the mechanism behind R2a.

Existing memories are shown to the model with integer labels and mapped back
afterwards. mem0's own code comments this as anti-hallucination and it is free.

An explicit `save_memory` stays synchronous. If a person asks Satchel to remember
something it must exist before they finish reading the reply. Supermemory carves out
the same case as `instant`.

### R2a What counts as a memory, and what only changes one

The current prompt has one blunt rule, "a work order is never a claim", and it spends
its longest section on it. That rule is right and too coarse. The distinction that
actually matters:

| what the user says | kind | memory? | effect |
| --- | --- | --- | --- |
| "fix this", "bump the client to 4.2" | directive, now | no | nothing |
| "I'm hitting a rate limit on the embedder" | situation, now | no | nothing |
| "I want entries to be append only" | intent | yes, spendable | add |
| "entries are append only" | standing fact | yes, durable | add |
| "no em dashes" | preference | yes, strengthens on repeat | add |
| "done, entries are append only now" | completion | **no** | **retires the matching intent** |

Two things follow.

**A completion is not a memory but it is a signal.** Today the prompt says "the fix
that landed is not a memory either" and drops it, which throws away the only evidence
that an intent is spent. It should retire the intent instead. An intent can die two
ways and both end in the same `retires`: the user says it is done, or R8's churn
check notices the repository moved.

**"Fix this" implies a problem, and the problem is not a memory either.** The
temptation is to record the bug as a durable fact about the project. It is not
durable: it will be fixed within the hour. Neither "the user wants this fixed later"
nor "the user is facing issue X" is a correct capture of an imperative.

This means memories need a kind, which R6 was already going to add for decay. The
kinds are load bearing twice: they set the lifetime, and they decide whether a row
can be retired at all. A standing fact cannot be retired by a completion; an intent
can.

**This contradicts a shipped worked example.** `capture-router.md` currently teaches:

> The user types: "ok so no personas in v1, and don't use em dashes anywhere. also
> the consent page still has that corner leak on .paper"
>
> You return three items. … And the corner leak with project "ledger", plus the open
> task about it if one is listed.

A bug report kept as a durable memory, and linked to a task. Both are wrong under
R2a and R9a. A worked example pulling the wrong way outweighs a paragraph of
instruction, so this one has to go when the prompt is revised.

### R3 The block, bounded

| | |
| --- | --- |
| supermemory | unbounded graph, retrieval ranks |
| Letta | small character capped blocks that live in context and get rewritten |
| our own eval | on the slice that matters most, loading scores nDCG 0.772 against retrieval's 0.174 |
| decision | **exceed supermemory, follow Letta** |
| status | **built**, `block_size` defaults to 30. Nothing past the cap is ended or hidden, only not injected, and `personal_memories` ranks by repetition then by when it was last meant so "the weakest line" is a fact. The consolidation prompt states the pressure only when the set is near the cap |

At eight memories, and at a realistic steady state of tens per scope, a memory set
fits in context whole. A cap is not a limitation here, it is the mechanism:

- it makes eviction forced, which makes consolidation happen
- it turns the extraction question from absolute ("is this durable forever", which
  the current 2000 word prompt still gets wrong) into comparative ("is this worth
  more than the weakest line in the block"), which a small model can answer
- it keeps the memory set small enough for a person to read, which is what
  ownership actually requires

Archive holds what is evicted. It is searchable on request and never auto injected.

### R4 Supersede and forget as flags, never deletes

| | |
| --- | --- |
| supermemory | `updates` edge, `isLatest` keeps retrieval on the current fact, `isForgotten` rather than delete, forget takes a reason |
| mem0 | history table records every add, update and delete with old and new text |
| today | `correct_memory` overwrites in place; the previous wording is gone |
| decision | **match** |
| status | **built**, `cf7f99e`. One `ended_at`/`ended_reason` with `replaced`, `retired` and `forgotten`, and `memory_events` written by a trigger so no writer can skip it |

Nothing is destroyed. Every change is an event with a before and an after. The user
chose auto apply for consolidation, and auto apply without an undo is not
acceptable, so this requirement is load bearing for R2 rather than optional.

### R5 Extends, not only replaces

| | |
| --- | --- |
| supermemory | three edges: `updates` replaces, `extends` enriches and both stay valid, `derives` infers |
| decision | **match updates and extends. Skip derives.** |
| status | **built**, `cf7f99e`. `extend_memory` re-embeds, and the event says `extended` rather than `corrected` so the history tells them apart |

Most of what looks like a contradiction is enrichment. Treating it as replacement
loses information.

`derives` is skipped deliberately, not for cost. A derived fact is one the user never
stated, which is in direct conflict with the source span rule in R9 and with the
stated goal of memory being information the user owns. If this is revisited it should
be as an explicitly marked, down weighted, reviewable class, the way supermemory
itself treats it.

### R6 Decay, expiry and confidence

| | |
| --- | --- |
| supermemory | facts persist until updated; preferences strengthen with repetition; episodes decay unless significant; `expiration_date` hides expired rows; inferred memories are down weighted until reviewed |
| today | one lifetime for everything, which is forever, and `heard` loads at full strength |
| decision | **match** |
| status | **mostly built**. Unconfirmed memories stopped loading in `da41ee7`, repetition counts in `28aeff2`, a user-stated expiry lands in `577a88c`. The decay curve is not built and needs a number |

Three separate pieces:

- a memory has a kind, and kinds have different lifetimes
- a memory can carry an expiry, and expired memories are hidden rather than deleted
- repetition is a signal. A claim restated across sessions is stronger than one said
  once, which is a free precision signal we currently throw away

The most urgent piece is the smallest: **a `heard` memory should not load at session
start until it is confirmed or seen again.** It stays retrievable, just not injected
by default. This alone would have kept both junk rows out of every session, and it is
worth shipping ahead of the rest of R6.

### R7 Temporal grounding

| | |
| --- | --- |
| mem0 | separates observation date from current date, and requires relative references to be resolved: "went to Paris last week" is useless six months later, "the week of 15 May" is not |
| today | no temporal anchor at all |
| decision | **match** |
| status | **built**, `28aeff2`. Both dates are in the prompt and every existing memory is shown with its age |

Without this nothing can judge a memory stale later. The live example is the personal
memory reading "do not include names of people who are not in the review list **this
time around**", which is a relative reference frozen into a permanent claim.

### R8 Staleness from the codebase

| | |
| --- | --- |
| supermemory | contradiction from conversation |
| mem0 | contradiction from conversation |
| decision | **exceed. Nobody we looked at does this.** |
| status | **built**, plugin 0.4.0. Stop sends a commit count, `repository_heads` holds it and only moves forward, the `anchor_memory` trigger stamps every memory with where the repository was when it was last meant, and `staleness_commits` decides when the marker shows. Nothing is ended by churn |

Both stale rows in production were made false by a migration and a commit. Nothing
anyone *said* contradicted them, so no amount of conversational contradiction
detection would ever have caught it. Every system we reviewed assumes the world
changes because the user mentions it. For a coding agent the world changes because
something merged.

Cheapest useful version, and it needs no model call to raise the doubt: a memory
scoped to a project whose linked repository has moved N commits since the memory was
last affirmed is injected with a doubt marker, the way a closed task already is, and
is offered to consolidation as a candidate to re-check.

### R9a A memory has one scope, and it is a project or personal

| | |
| --- | --- |
| today | `memories.task_id`, set by the model, with a scope agreement check |
| decision | **remove it** |
| status | **built**, `4ac8841`. The column, the index, the foreign key, the router field, the `validate()` overwrite, the scope check, the MCP argument, the retrieval hint and the web app's type |

A memory belongs to exactly one project, or to personal. Nothing else. The task link
goes, and it takes several things with it:

- the `task` field leaves the router schema, so the model makes three decisions per
  item instead of four
- `validate()`'s `project: task ? taskProject : project` goes, and with it a silent
  scope overwrite where a wrong task guess moves a memory into another project
- the scope agreement check in `save_memory` goes, and so does the `(owner_id, id)`
  foreign key that exists only because Postgres refuses `ON DELETE SET NULL` against
  a generated `scope_key`
- the `[task closed, may be fixed]` hint in `injection-format.mjs` goes, which was
  the only thing the link ever produced

**This is not the same as routing a work order into a task.** That would create a
task and no memory and no link, which R9a does not forbid. Open question in the last
section.

### R11 Observability, end to end

| | |
| --- | --- |
| today | Stop is traced. Session start deliberately is not. Two tracing bugs were found and fixed on 21 September: the system prompt was never on the trace, and the router's metadata went nowhere |
| decision | **required, and it gates everything else** |
| status | **built**, `cf7f99e` and `61cf35f`. `traced()` hands back the trace id, every `memory_events` row carries it, `consolidation_runs` holds the prompt, the reply, the counts, the tokens and the duration, and the trace output is the list of actions including the rejected ones |

Consolidation runs in the background on a schedule. Nobody watches it. If it is not
legible in Langfuse then a bad memory has no explanation and this whole design is
unauditable in exactly the way the current one is.

A consolidation run must produce one trace that answers, without reading the
database:

- which session and which document it read, and how much of it
- which memories were already in scope, as the model was shown them
- the prompt actually sent, system half included, and which prompt version
- what the model returned, verbatim
- **every action taken and why**: added, extended, replaced, retired, or rejected by
  validation, each naming the memory it touched
- what it cost and how long it took

The last point is the one that does not exist for any current write. `memory_events`
from R4 should carry the trace id, so a row in the database and the reasoning that
produced it are one click apart in both directions.

The two bugs fixed on 21 September are a warning rather than a footnote. Both were
silent, both were invisible to the suite, and one of them made every trace missing
the exact thing needed to argue about a capture after the fact. Tracing needs its
own tests, not just its own code.

### R9 Must not regress

These are ours. Two of them do not exist in either system we studied and the third is
what makes Satchel safe to give to someone else.

| | |
| --- | --- |
| **source span** | every captured memory carries words the user actually typed, and the item is dropped if the span is not in the turn. This is the only anti fabrication guard any of these systems has, and `dropped=0` over 100 runs says it costs nothing to keep |
| **RLS authoritative** | isolation is enforced by the database for every caller, not by application code passing the right tag. Supermemory self hosted is single tenant behind one API key, which inverts this |
| **repo to project scope** | resolved automatically from the git remote. Supermemory's container tag is an opaque string it never interprets, so this is work it pushes onto whoever integrates it |
| **said and heard** | the band already exists and is the same idea as supermemory's `isInference`. R6 is mostly about finally using it |
| **tasks and projects exist in the same system** | memory is not a separate product here, so a work order has somewhere to go. Note this is about routing, not linking: R9a removes the memory-to-task link entirely |

### R10 Runs locally, in containers

| | |
| --- | --- |
| goal | the whole system starts on one machine with one command, and deploys anywhere |
| today | Vercel functions plus hosted Supabase. `npm run dev` runs Vite only. There is no `supabase/config.toml`, so the local Supabase stack has never been stood up. The `api/*.mjs` handlers have no local runner |
| decision | **required, and it gates the benchmark** |
| status | **built and partly unverified**, `1e5842c`. `npm run serve` is run and tested. The Dockerfile, the compose file and `supabase/config.toml` were written without a Docker daemon or the Supabase CLI and have not been brought up. See `docs/running-locally.md` |

Scope of the work, in order of certainty:

- `supabase init` and a config, so `supabase start` brings up Postgres, GoTrue,
  storage and pgvector locally. This proves the migrations, the RLS policies and the
  access token hook against a fresh database, which has never been done.
- A small local server that mounts the existing `api/*.mjs` handlers, so the hook
  endpoints and the MCP endpoint can be exercised without deploying.
- A Dockerfile for the app plus a compose file that wires it to the Supabase stack
  and, for the benchmark, to a supermemory local container.

Two things to be explicit about. Satchel's auth and isolation are Supabase specific:
GoTrue issues the JWT, a custom access token hook puts the grant claims in it, and
RLS reads them. Replacing Supabase is not in scope, and running it locally is the
supported path. Secondly, nothing about this changes the production deployment.
Vercel plus hosted Supabase stays the target; containers are for development,
measurement, and keeping the option of deploying elsewhere open.

## Non-goals

Stated so they do not get relitigated mid build.

- **No knowledge graph, no bitemporal edges.** Zep and Graphiti need four timestamps
  per edge because their graph is unbounded. R3's cap removes the problem those
  mechanisms solve.
- **No trained extraction model.** Supermemory's real advantage is a proprietary
  model and we are not going to match it with a prompt. R1 through R8 are the parts
  that do not need one.
- **No derived facts.** See R5.
- **No multi-modal ingestion, no connectors.** Out of scope, but R1's document shape
  should not make them impossible later.
- **No ingestion of source code.** Code is enormous and churns every commit. It would
  swamp the memory set with claims that are true for a week. Documents are about the
  work, not the work itself.
- **No replacement of Supabase.** See R10.

## How we will know it is done

### The head to head

Once R1 exists there is raw material to replay, which is what makes this cheap.

```
the same documents, drawn from real sessions
        │
        ├──► supermemory local, on Gemini      ──► memory set A
        └──► Satchel consolidation, on Gemini  ──► memory set B
                        │
              both labelled by hand, same rubric, labels recorded
```

Supermemory local is MIT licensed, installs as one binary, embeds its own graph
engine and takes a Gemini key, so this costs an afternoon and no money.

### Acceptance

| measure | bar |
| --- | --- |
| precision, share of rows you would defend | at least supermemory's, on the same documents. Today's figure is 3 of 8 |
| missed durable claims | no worse than supermemory's, within the noise of a hand labelled set |
| staleness | a claim contradicted later in the same documents must not still be live. Today: zero of two caught |
| manual deletions per week | trending to zero. Currently around six in two days |
| context pollution | no unconfirmed `heard` memory loads at session start |
| isolation | R9 holds, proven by the existing cross account tests in `tests/security-audit.test.mjs` |

The second measure is the cheap one and it is nearly as good as the first. If you stop
deleting memories by hand, it is working. If you do not, nothing else matters.

## Open decisions

These change the work and are not mine to make.

**Settled.**

1. **Document retention: 30 days, then delete.** Derived memories survive. This is
   the option that makes re-running after a *prompt change* possible, which is most
   of R1's value, and it is also the largest privacy surface of the three, so the
   deletion has to be real and testable rather than a policy sentence.
2. **Document granularity: one session, one document.** The coherent unit, and
   supermemory's own default because extraction quality is higher.
3. **The five orphan rows: Neeraj will handle them.** No production writes from the
   agent. Until then those rows stay unsearchable, so any measurement taken before
   that is measuring a corpus with five invisible members.

4. **Consolidation runs on a schedule, roughly every six hours**, over sessions whose
   last turn is older than an idle threshold. A session still being typed into is not
   ready. Worst case latency between saying something and it being remembered is one
   cron interval, which is acceptable because explicit `save_memory` stays
   synchronous.
5. **Memory scope is project or personal only.** See R9a.

**Still open.** These are what is left. Everything else in this document is
built.

6. **What actually runs the six hourly schedule.** `/api/consolidate` exists and
   takes the credential the hook scripts already hold, so any of the three can
   call it without a new kind of secret. Nothing calls it yet. Vercel Hobby caps crons at once
   per day and rejects a more frequent expression at deploy time; Pro allows per
   minute at $20/mo per user. Free alternatives, in the order I would try them:
   Supabase `pg_cron` with `pg_net` calling the endpoint, since the database is
   already there; a GitHub Actions schedule doing an authenticated `curl`; or lazy
   processing on the next hook, which needs nothing new but puts model work inside a
   hook timeout. The idle threshold is an argument to the endpoint and defaults to
   30 minutes, which is a placeholder rather than a measurement.

   Until this is answered `capture_mode` stays `turn`, because switching it
   without something calling the endpoint would mean no capture at all.
7. **Does a work order become a task, or nothing?** R9a removes the memory-to-task
   link, which is settled. Separately, the classifier could file a directive as a
   task instead of discarding it. That creates no memory and no link, so R9a does not
   forbid it, but it is a new behaviour and it has not been agreed.
8. ~~**The block cap.**~~ Answered: 30 per scope, and it is `memory_settings.block_size`
   rather than a constant. At eight memories it does not bind, which is the
   argument for shipping the shape before the pressure arrives.

9. ~~**Whether R8 is worth a plugin release.**~~ Answered: yes. Plugin 0.4.0
   sends a commit count from the Stop hook. A count and nothing else: not a
   message, not a sha, not a path.
