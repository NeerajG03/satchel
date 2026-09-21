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
- **The Codex router reads the user's messages without the replies.** A stated degradation, not a bug to chase.

## The hooks, which are the same on both hosts

```
SessionStart  matcher ^(startup|clear|compact|resume)$
  command   bootstrap.mjs                    detects the git remote, stages the repository
  mcp_tool  load_memory_context event=SessionStart

UserPromptSubmit  timeout 5s
  mcp_tool  load_memory_context event=UserPromptSubmit
            input: session_key, prompt, user_prompt

Stop  timeout 10s
  mcp_tool  load_memory_context event=Stop
            input: session_key, last_assistant_message
```

`resume` is included because a resumed session may be days old and needs the projects list most. It was excluded when a whole index loaded, since that duplicated context onto a session that already had it. With retrieval the block is small.

`UserPromptSubmit` has a deliberately short timeout: a hook that delays the prompt is worse than a hook that misses one.

**Both prompt spellings are sent.** Codex documents `prompt`; Claude's published reference is truncated at this event, and the one working plugin in the wild reads `prompt` with no fallback while a summary of the same docs says `user_prompt`. An unsubstituted `${...}` arrives as its own literal text, and the server discards anything still shaped like a placeholder, so sending both costs nothing. The same discard covers `last_assistant_message`, which exists on Claude and not on Codex.

**`${path}` substitution in `mcp_tool` input works on both hosts.** This was once reported as a Claude defect and withdrawn: the documentation says string values in `input` take substitution from the hook's own JSON.

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

## The three lifecycle events

### SessionStart

Loads the projects list and **every personal memory**, whole. Nothing scoped to a project or a task, because loading that assumes you will touch it.

If the block exceeds `session_budget_tokens`, it is **withheld entirely** with a message saying so, not truncated. A partial block that looks complete is worse than an honest absence, because the agent cannot tell the difference.

If Satchel is unreachable, the injected text says memory was not loaded and tells the agent not to invent it. Degrading to silence and saying so is the rule everywhere.

### UserPromptSubmit

1. Record the prompt in the rolling window, if capture is on. This happens whether or not anything is retrieved, because the window the router reads is built from exactly this.
2. Embed the prompt.
3. `search_memories` with the user's gate, boost and cap.
4. Format the block, which carries counts: `retrieved · N shown · M matched · K in scope`. The counts are the point. They let the agent tell "there is no rule about this" from "nothing scored high enough", which is the failure a silently truncated top five causes.
5. Log the injection. A failure to log never fails the injection it was recording.

Returning nothing is a real answer and keeps the per-prompt cost at zero on turns that need nothing.

### Stop

1. Record the assistant's final text, where the host provides it.
2. Read the rolling window.
3. Split it: the last `capture_window` user messages are **the turn**, and everything before is context for understanding it. Only the turn may supply a source.
4. Call the router with the projects list, the open tasks, the context and the turn.
5. Write whatever survives validation, as `heard`.
6. Log the run: the full prompt, the raw reply, and how many were kept and dropped.

Nothing is injected.

## The layers, and what each one owns

**`server/mcp-server.mjs`** owns the tool surface and the lifecycle handler. It is the only thing that formats hook JSON. `load_memory_context` is deliberately read-only.

Tools: `load_memory_context`, `memory_index`, `retrieve_memory`, `read_memory`, `save_memory`, `correct_memory`, `confirm_memory`, `delete_memory`, `list_projects`, `select_project`, `upsert_project`, plus the task tools when the grant allows.

**`server/memory-service.mjs`** is the only place that talks to the database. Request scoped. RLS stays authoritative even for direct RPC calls, so this layer is convenience and not security.

**`server/embedding.mjs`** turns text into a vector, provider independent. Two rules the rest of the system depends on: everything is L2 normalised here, and a failure throws rather than returning a zero vector or a partial batch.

**`server/router.mjs`** is the capture model. `buildPrompt` assembles the window; `validate` drops anything that does not hold up; `createRouter` handles the call, including falling back from a JSON schema to asking in words when a provider rejects the schema outright.

**`server/prompt-store.mjs`** resolves the capture wording. Langfuse holds it as the prompt `satchel-capture-router`, labelled `production`; `server/prompts/capture-router.md` is the copy you edit and the fallback when Langfuse is slow, down or unconfigured. One fetch per warm instance, an hour of cache, and a failure is cached too so an unpublished repo does not pay a request per turn. Whichever was used is named on the trace.

**`server/injection-format.mjs`** is pure and holds the exact bytes that reach the model, so the context preview can render what was actually injected rather than a description of it.

**`server/tracing.mjs`** is Langfuse. Every export is safe to call when it is unconfigured and nothing in it can throw into a request.

## Scope, which is never inferred

Every memory lives in exactly one scope. `project_id = null` is personal; anything else is an explicit project UUID. Scope is never chosen from a directory name or a similar-looking project name.

A memory may hang off a task, but only a task **in its own scope**. `save_memory` checks this and raises something readable rather than letting a constraint fire. Without it a router mistake could tag a personal rule to a project task, and the rule would then be flagged stale when that task closed.

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
SPAN        satchel.Stop
GENERATION    router                 model=gemini-3.5-flash-lite  usage={input,output,total}
```

The router's full prompt is the input on purpose. A capture is only explicable if you can see what the router was looking at, including which projects and open tasks it had to choose from. Kept **and** dropped items are both recorded, because a router being silently filtered looks identical to one being conservative.

Spans are flushed before the handler returns, because a serverless function can freeze the moment it responds.
