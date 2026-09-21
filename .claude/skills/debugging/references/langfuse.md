# Reading Langfuse

Langfuse is where every model call goes. US cloud, project `satchel`. One trace per lifecycle event, grouped by session, so a capture can be read next to the retrievals that preceded it in the same conversation.

## Getting in

Credentials are in `~/.config/env` and nowhere else. Read them without sourcing the whole file, because sourcing it has clobbered `PATH` in the past and left `curl` unavailable for the rest of the session:

```bash
PK=$(grep '^export LANGFUSE_PUBLIC_KEY=' ~/.config/env | cut -d= -f2-)
SK=$(grep '^export LANGFUSE_SECRET_KEY=' ~/.config/env | cut -d= -f2-)
BU=$(grep '^export LANGFUSE_BASE_URL=' ~/.config/env | cut -d= -f2-)
AUTH=$(printf '%s:%s' "$PK" "$SK" | base64)
curl -s -H "Authorization: Basic $AUTH" "$BU/api/public/v2/observations?limit=10"
```

`npx langfuse-cli api <resource> <action> --help` is the fastest way to discover an endpoint's arguments. It wants `LANGFUSE_HOST` as well as `LANGFUSE_BASE_URL`.

## Which endpoints exist

This organisation was created after 16 September 2026, so the v1 endpoints are gone. Discovering that by trial takes twenty minutes, so it is written down:

| Endpoint | Status |
| --- | --- |
| `GET /api/public/v2/observations` | works, and is the main tool |
| `GET /api/public/v2/prompts` and `/{name}` | works, and is where the capture wording lives |
| `POST /api/public/v2/prompts` | works, creates a version and moves a label |
| `GET /api/public/models` | works |
| `POST /api/public/models` | works |
| `GET /api/public/observations/{id}` | **410** `LEGACY_API_UNAVAILABLE_FOR_NEW_ORGANIZATION` |
| `GET /api/public/traces/{id}` | **410**, same |
| `GET /api/public/metrics/daily` | **410**, same |
| `GET /api/public/v2/observations/{id}` | **404**, there is no detail route |
| `GET /api/public/v2/traces/{id}` | **404** |

There is no way to fetch a single observation or a whole trace by id. Everything is done by listing with filters.

## The field-selection trap, which is the important part of this file

**The default projection hides almost everything worth debugging.** `fields` defaults to `core,basic`, which gives ids, names, types, timing, `userId` and `sessionId`, and nothing else.

Read without it, every generation looks like this:

```
GENERATION  chat gemini-3.5-flash-lite   modelId=null   totalPrice=null
```

That looks exactly like "Langfuse is not resolving the model and not computing cost". It is not. Ask for the fields:

```bash
curl -s -H "Authorization: Basic $AUTH" \
  "$BU/api/public/v2/observations?limit=10&type=GENERATION&fields=core,basic,model,usage"
```

```
model=gemini-3.5-flash-lite  internalModelId=cmuay7o0s0sl0ad0cmgn1uzzb
usageDetails={"input":2061,"output":68,"cache_read_input":0,"total":2129}
costDetails={"input":0.0006183,"output":0.00017,"total":0.0007883}
```

Two things to carry away. `modelId` in the default projection is **not** the resolved model definition; `internalModelId`, under `fields=model`, is. And a null in a projection that does not contain the field is not a null, it is an absence.

The groups: `core` (always), `basic`, `time`, `io` (input and output), `metadata`, `model`, `usage` (usage, cost, pricing tier), `prompt`, `metrics` (latency), `trace_context` (tags, release, trace name).

Useful filters: `type=GENERATION|EMBEDDING|SPAN|RETRIEVER|AGENT`, `userId`, `sessionId`, `name`, `fromStartTime`. Filtering by `userId` is the reliable way to isolate one local probe run from production traffic.

## The shape of a Satchel trace

```
SPAN       satchel.UserPromptSubmit          ← ours, one per lifecycle event
  EMBEDDING  embeddings gemini-embedding-001   ← the AI SDK's, one per embed call
  RETRIEVER  retrieve-memory                   ← ours, the pgvector lookup
SPAN       satchel.Stop
  AGENT      invoke_agent gemini-3.5-flash-lite  ← the AI SDK's outer call
    GENERATION chat gemini-3.5-flash-lite        ← the actual model request
```

`satchel.*` spans are opened by hand in `server/tracing.mjs`. Everything under them is emitted by the Vercel AI SDK. `retrieve-memory` is the only hand-opened child, because it is a database query and the SDK has no opinion about it.

`sessionId` is the agent's session key, `userId` is the owner id. Never an email, never a token. Anything shaped like a key is masked by the span processor before it leaves the process.

## The gen_ai bridge, and why it exists

The AI SDK describes its calls in OpenTelemetry's GenAI convention: `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.input.messages`. Langfuse reads its own `langfuse.observation.*` names. `genAiToLangfuse` in `server/tracing.mjs` translates between them on the way out.

If a generation shows no model or no cost, check that bridge first. It is also the place to extend when a provider reports a usage field nobody has mapped yet.

## Model definitions and cost

Cost is only computed when a model definition matches the model name. Langfuse's built-in list stops well short of current models, so ours are defined by hand:

```
gemini-3.5-flash-lite   input 3e-7    output 2.5e-6    ($0.30 / $2.50 per 1M)
gemini-embedding-001    input 1.5e-7  no output        ($0.15 per 1M)
```

Prices are **per token**, not per million. Langfuse stores its own that way, and getting it wrong by six orders of magnitude does not error, it just produces a number nobody questions.

```bash
npx langfuse-cli api models create --body-file model.json
```

A definition applies at ingestion, so it never reprices observations that already arrived. To test one, make a new call.

An embedding with `usageDetails={}` is normal: Google's embed endpoint does not report token counts, so there is nothing to price.

## Which wording produced a capture

The capture instructions are a Langfuse prompt, `satchel-capture-router`, not a string in the code. Every router generation carries `promptName`, `promptVersion` and `promptSource` in its metadata, so a trace from before a wording change and one from after are distinguishable, which is the whole reason the prompt moved:

```bash
curl -s -H "Authorization: Basic $AUTH" \
  "$BU/api/public/v2/observations?limit=20&type=GENERATION&fields=core,io,metadata"
```

`promptSource: local` means the instance did not reach Langfuse and used the copy committed at `server/prompts/capture-router.md`. That is a healthy fallback, not a fault, but a run of them means the fetch is failing and the published version is not the one being served.

To read a version's text, or to compare two:

```bash
curl -s -H "Authorization: Basic $AUTH" "$BU/api/public/v2/prompts/satchel-capture-router?version=1"
node eval/router-rigour.mjs --prompt 1 --prompt production
```

## What a trace can tell you that nothing else can

- **What the router actually saw.** The whole prompt is the span input on purpose, including the projects and open tasks it had to choose from. A capture is only explicable if you can see the menu it was choosing from.
- **Kept and dropped, separately.** A router being silently filtered by `validate()` looks identical to one being conservative. Both lists are recorded.
- **Why a call failed.** The `reason` on the error is a plain sentence, not a status code.
- **Where the time went.** `latency` per observation, so a slow turn resolves into embed, lookup or model.
