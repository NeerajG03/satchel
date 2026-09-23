# The path a memory takes, end to end

## The two hosts are not symmetric, and the design is shaped by that

| | Claude Code | Codex |
|---|---|---|
| `SessionStart` + `additionalContext` | yes | yes |
| `UserPromptSubmit` + `additionalContext` | yes | yes |
| `Stop` + `additionalContext` | yes, arrives as a system message next turn | no |
| `Stop` carries the assistant's final text | yes, `last_assistant_message` | no |
| `PostCompact` can inject | yes | **no** |
| hook handler types | command, mcp_tool, prompt, agent | **command and mcp_tool only** |

Consequences that are load-bearing:

- **Nothing is injected from `Stop`.** Claude can and Codex cannot, so using it would work on one host only. Stop is capture and nothing else. The next turn may change subject anyway, so prefetching there was never worth it.
- **Compaction goes through `SessionStart`, never `PostCompact`.** Codex cannot emit `additionalContext` from `PostCompact`, so a hook there would never reach the model. Both hosts use the `compact` source of `SessionStart` instead. `tests/plugin-bootstrap.test.mjs` asserts `PostCompact` is absent.
- **A Codex document holds the user's messages without the replies**, so the pass reads one side of a Codex conversation. A stated degradation, not a bug to chase, and it caps how good Codex consolidation can get.

## The hooks, which are the same on both hosts

Every hook is a `command` script in `integrations/shared/` that holds its own credential and calls one endpoint. None goes through MCP, because an `mcp_tool` hook cannot run at launch; see `satchel-apps` `references/plugin.md` for why.

```
SessionStart      matcher ^(startup|clear|compact|resume)$   timeout 10s
  session-start.mjs  ──▶ POST /api/hook-index      projects list and the personal block

UserPromptSubmit  timeout 5s
  retrieve.mjs       ──▶ POST /api/hook-retrieve   record the user's half, then search

Stop              timeout 25s
  capture.mjs        ──▶ POST /api/hook-capture    record the reply and the commit count

nothing in a hook
  cron or the button ──▶ POST /api/consolidate     the background pass
```

Every script reads the host's JSON on stdin, where both hosts agree on the field names: `prompt` on `UserPromptSubmit`, `last_assistant_message` on `Stop` (Claude only). The repository is read from `git config --get remote.origin.url` and sent as a normalized `owner/repo`, and Stop also sends `git rev-list --count HEAD` as `commits`. A count and nothing else, no sha and no path.

`resume` is included because a resumed session may be days old and needs the projects list most. With the block capped it is small.

`UserPromptSubmit` has a deliberately short timeout: a hook that delays the prompt is worse than a hook that misses one.

## What runs where

Everything except detecting the git remote runs on the server.

```
user's machine                  server (Vercel)                database (Supabase)
--------------                  ---------------                -------------------
hook fires
  session_key, prompt   ──────▶ verify the agent JWT
                                memoryService(db, embedder, router)
                                embed the prompt      ──▶ Gemini
                                                       ◀── vector
                                                       ──▶ search_memories
                                                       ◀── rows above the gate
                                format the block
  additionalContext     ◀────── hookSpecificOutput
```

No key, no prompt text, no ranking logic and no routing logic ever lands on the user's machine. The local bootstrap script sees a repository name and nothing else, and it is asserted never to expose remote credentials.

## The three lifecycle events, and the pass

### SessionStart

Loads the projects list and the **personal block**: live personal memories, confirmed only, ranked by `personal_memories` (most mentioned, then most recently affirmed) and cut at `block_size`, 30 by default. Unconfirmed ones are counted in the notice, never injected. Nothing scoped to a project loads here, because loading that assumes you will touch it.

Nothing past the cap is ended or hidden. It is simply not injected, and it is still retrievable per prompt.

If the block exceeds `session_budget_tokens`, it is **withheld entirely** with a message saying so, not truncated. A partial block that looks complete is worse than an honest absence, because the agent cannot tell the difference.

If Satchel is unreachable, the injected text says memory was not loaded and tells the agent not to invent it. Degrading to silence and saying so is the rule everywhere.

### UserPromptSubmit

1. Record the user's half through `record_turn`, into both `session_messages` and the session's document, if `capture` is on. **Awaited**, in its own try/catch. It used to be fired with `void`, and a Vercel function freezes when it responds, so the user's half, the only half that can supply a source, could be lost. A failure here produces an "unrecorded" notice rather than failing retrieval.
2. Embed the prompt.
3. `search_memories` with the user's gate, boost and cap.
4. Format the block, which carries counts: `retrieved · N shown · M matched · K in scope`. The counts are the point. They let the agent tell "there is no rule about this" from "nothing scored high enough", which is the failure a silently truncated top five causes. A project memory whose repository has moved `staleness_commits` or more since it was last meant carries a doubt marker saying how far.
5. Log the injection. A failure to log never fails the injection it was recording.

Returning nothing is a real answer and keeps the per-prompt cost at zero on turns that need nothing.

### Stop

1. If `capture` is off, stop here. The setting is about whether the conversation is kept at all.
2. Resolve the scope, before the write, because the scope is part of what is recorded. A pass reading the document hours later has no workspace and no git remote.
3. Record the repository head, if the hook sent `commits`. `repository_heads` only moves forward.
4. Record the assistant's half through `record_turn`. Called even with an empty reply: Codex sends none, so there it only sets the document's scope.
5. If `capture_mode` is `session`, which is the default, **stop here**. No memory is written at the end of a turn.
6. Only in `turn` mode: read the window, split it into the turn (the last `capture_window` user messages) and the context before it, call the router, write what survives validation as `heard`, and log the run to `router_runs`.

Nothing is injected.

### The consolidation pass

`POST /api/consolidate`. Nothing in a hook calls it. Two things do: the developer-only `pg_cron` job, and the "Consolidate now" button on the activity page. A Stop hook that spawned it detached was built and reverted on 22 September, because a hook that quietly spends a model call is the wrong default.

Pressing the button starts a **job** and returns at once. The job is a row in `consolidation_jobs` and a chain of calls to the same endpoint, each one about four minutes (`SATCHEL_CONSOLIDATE_STEP_MS`, 240000), for up to 30 minutes in all. One call cannot do it alone: Vercel stops a function at 300 seconds on Hobby, whatever framework it is in.

```
POST {idle_minutes}   start_consolidation_job, or show the one already running
  answer 202 {job} now, then under waitUntil:
  consolidateStep(job)
    pending_documents(idle, no count), minus the sessions this job already tried
    for each, while inside this call's four minutes and the job's 30:
    document_content(after consolidated_through)   only turns not yet read
    memories_in_scope(project)                     project + personal, integer labels
    consolidator.consolidate()                     one call, gemini-3.8-flash, thinking medium
    validate()                                     source must be in the user's words
    apply: capture_memory | extend_memory | end_memory | affirm_memory
           each under private.attribute(trace, document, reason)
    mark_document_consolidated(through)
    log to consolidation_runs, including runs that changed nothing or failed
      move the job row: read, counts, and this session's run with every action and why
  more left?  POST {job, step} to publicOrigin(), with the same access token
```

The row is moved after every session, so the page shows progress and a call that dies loses one session at most. `step` is a lease: a call claims `step + 1` only if the row is still at the step it was handed, so a "carry on" pressed while the chain is alive gets a 409 instead of reading a session twice. A running job whose `heartbeat_at` is over six minutes old has lost its chain, and anyone who owns it may take it over. A job stops and says why on the row: nothing left, the 30 minutes ran out, the model's quota is spent (the consolidator already tried its fallback), or three sessions failed in a row. A session that failed stays pending for the next job but is not asked about again in this one.

`publicOrigin()` is where the chain sends itself: `SATCHEL_PUBLIC_URL`, then `VERCEL_PROJECT_PRODUCTION_URL` in production, then `VERCEL_URL`. Never the request's Host header, because the chain carries the caller's token. The cron gets a real 202 inside pg_net's five seconds now, where it used to time out on a pass that was working.

It accepts three credentials, all under RLS as the owner: the hook scripts' agent bearer, a **companion session** (the button, checked by `verifyCompanionToken`, which refuses any token carrying a `client_id`), and `x-satchel-refresh` (the cron, a refresh token the endpoint exchanges and rotates). It is the only endpoint that accepts the last two.

**Model choice.** One costly call per session instead of one cheap call per turn, so `gemini-3.8-flash` with `thinkingLevel: 'medium'` through `SATCHEL_ROUTER_MODEL` and `SATCHEL_THINKING_LEVEL`. If the host answers 5xx or the daily quota for that model is spent, it falls back once to `SATCHEL_MODEL_FALLBACK` (`gemini-3.5-flash`) and avoids the first model for five minutes on that instance. `decisions.md` has the measurements.

## The layers, and what each one owns

**`server/mcp-server.mjs`** owns the tool surface. It does not format hook JSON any more; the hook endpoints do, through `hook-handler.mjs`.

Tools: `list_projects`, `upsert_project`, `select_project`, `memory_index`, `retrieve_memory`, `read_memory`, `save_memory`, `correct_memory`, `confirm_memory`, `forget_memory`, plus the task tools when the grant allows. `select_project` with an `event` is the recovery path for a session whose hook could not run, and returns what the hook would have injected.

`forget_memory` ends the row as `forgotten` through `end_memory`, the same call the web app's Forget makes, after checking the memory is in the scope the agent named. No tool deletes a memory. It used to be `delete_memory` and ran a real `DELETE`.

**`server/hook-handler.mjs`** owns the four endpoints and `connect()`, which verifies the caller and builds the request-scoped service. `allowRefresh` and `allowCompanion` are off everywhere except `/api/consolidate`.

**`server/memory-service.mjs`** is the only place that talks to the database. Request scoped. RLS stays authoritative even for direct RPC calls, so this layer is convenience and not security.

**`server/embedding.mjs`** turns text into a vector, provider independent. Two rules the rest of the system depends on: everything is L2 normalised here, and a failure throws rather than returning a zero vector or a partial batch.

**`server/router.mjs`** is the per-turn capture model, used only in `turn` mode. `buildPrompt` assembles the window; `validate` drops anything that does not hold up; `createRouter` handles the call. `asModelError` lives here and is shared with the pass: it turns an SDK failure into a `RouterError` with a plain-words `reason`, and keeps the HTTP `status` so the fallback can tell a 5xx from a 4xx.

**`server/consolidator.mjs`** is the pass's model call: it relabels memories as integers, builds the prompt with both the observation date and today's date, calls the model with a structured schema, and `validate()` maps labels back and drops anything whose source is not in the user's words, whose label does not exist, which touches a memory a second time in one run, or which retires something that is not an `intent`. A validator that refuses to let a completion retire a fact is the guard the prompt cannot be trusted to be.

**`server/consolidation.mjs`** applies it. `consolidateDocument` for one document, `consolidateStep` for one call's share of a job, `consolidatePending` for a plain batch with a clock, which nothing in production calls any more. It returns what it did rather than throwing, because one document failing must not end the others.

**`server/secrets.mjs`** takes keys, passwords and tokens out of text before it is kept. `hook-handler.mjs` scrubs the prompt and the reply as they arrive, so the document, the window, the embedder, the injection log and the trace only ever see the redacted copy, and the pass scrubs the turns it reads again for anything stored before. Known shapes are always taken out; a value next to a secret-sounding name only when it looks random. It is a pattern scanner rather than a model, because asking a hosted model whether something is a secret means sending it the secret.

**`server/model-provider.mjs`** picks the SDK provider for a model id, and holds `fallbackModel` and `worthAnotherModel`.

**`server/prompt-store.mjs`** resolves both prompts. Langfuse holds `satchel-capture-router` and `satchel-consolidate`, labelled `production`; `server/prompts/capture-router.md` and `server/prompts/consolidate.md` are the copies you edit and the fallback when Langfuse is slow, down or unconfigured. One fetch per warm instance, an hour of cache, and a failure is cached too. Whichever was used is named on the trace.

**`server/injection-format.mjs`** is pure and holds the exact bytes that reach the model, so the context preview can render what was actually injected rather than a description of it.

**`server/tracing.mjs`** is Langfuse. Every export is safe to call when it is unconfigured and nothing in it can throw into a request. `traced()` hands the trace id to its callback, which is how it reaches `memory_events`.

## Scope, which is never inferred

Every memory lives in exactly one scope. `project_id = null` is personal; anything else is an explicit project UUID. Scope is never chosen from a directory name or a similar-looking project name.

There is no task link. `memories.task_id` was removed in `20260922100000` (R9a), with the router field, the scope check in `save_memory` and the `[task closed, may be fixed]` hint. The doubt that hint was for now comes from the repository moving (R8).

A document has the same scope rule. It is set by whichever turn first knows it and never cleared, and a project id the caller does not own is dropped rather than borrowed. The pass writes into the document's scope, except that a preference said inside a project may still land in personal, which is why it is shown both.

## Slugs

A model copies an identifier and rewrites a title, so slugs exist. They are unique per user across projects and tasks together, supplied on create rather than derived, and the derived form exists only so no row can ever lack one.

`create_task_with_slug` and `upsert_project_with_slug` are thin wrappers so a create and its slug are one round trip and one transaction. A slug collision rolls the create back rather than leaving a task named after its title.

## Tracing

One trace per lifecycle event, grouped by `sessionId`, attributed to the owner's id and never an email or a token.

Each call gets its most specific observation type, which is what makes the latency breakdown and the cost analytics work:

```
SPAN        satchel.UserPromptSubmit
RETRIEVER     retrieve-memory
EMBEDDING       embed                model=gemini-embedding-001
SPAN        satchel.Stop                         turn mode adds a router GENERATION
SPAN        satchel.consolidate                  one per document
GENERATION    consolidate            model=gemini-3.8-flash  usage={input,output,total}
```

A consolidation trace answers R11 without the database: which document and how many turns, which memories it was shown, the prompt and its version, the raw reply, and every action taken **and** every one validation refused, each naming the memory it touched. Every `memory_events` row it causes carries the same trace id, so a row and the reasoning behind it are one click apart.

The router's full prompt is the input on purpose. A capture is only explicable if you can see what the router was looking at, including which projects and open tasks it had to choose from. Kept **and** dropped items are both recorded, because a router being silently filtered looks identical to one being conservative.

Spans are flushed before the handler returns, because a serverless function can freeze the moment it responds.
