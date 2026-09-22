# Running Satchel on one machine

Production is Vercel plus hosted Supabase and none of this changes that. This is for two things: exercising an endpoint without a deploy, and measuring the memory system against something else on the same input.

Both were missing. Nothing could call a hook endpoint locally, which is why the two tracing bugs found on 21 September were the kind you only find in production. And "our baseline is supermemory" is a claim with a number behind it or it is nothing, which means running both over the same conversations.

## The app and the endpoints

```bash
npm run build && npm run serve
```

One port, routed the way the deployment routes it: the built app at `/`, every file in `api/` under `/api/`, and the rewrites read out of `vercel.json` rather than restated. A second copy of the routing would be a second thing to forget, and the failure it produces is a local run that behaves differently from the deployed one, which is worse than no local run.

`npm run dev` still runs Vite alone, which is the faster loop when you are only changing the app.

With no environment set, the endpoints answer exactly the way a deploy with a missing key answers. That is worth being able to see rather than something to fix.

## The database

There is a `supabase/config.toml` now, so:

```bash
supabase start      # Postgres, GoTrue, storage, pgvector
supabase db reset   # every migration, against an empty database
supabase status     # the URL and the keys
```

Then point the app at it:

```bash
SATCHEL_SUPABASE_URL=http://127.0.0.1:54321 \
VITE_SUPABASE_PUBLISHABLE_KEY=<from supabase status> \
npm run serve
```

`SATCHEL_SUPABASE_URL`, not `SUPABASE_URL`. The second is a common variable name, and a deployment that happened to have one set for something else would silently start verifying tokens against a different issuer, which is not a failure anyone would spot.

**What this catches that the test suite cannot.** `tests/` runs every migration in PGlite on every `npm test`, which is a real Postgres and catches most of what matters. It is not Postgres-with-Supabase: there is no pgvector, so the type and the distance operator are shimmed, and there is no GoTrue, so `satchel_access_token_hook` has never actually run. That hook is how grant claims reach RLS. A local stack is the only place it runs for real.

## In a container

```bash
docker compose up --build
```

The image builds the app and runs the same server. Local Supabase stays the CLI's job: it manages its own set of containers and duplicating that here would be a second, worse copy of it. On macOS and Windows the app container reaches it at `host.docker.internal:54321`, which is what `compose.yaml` defaults to.

Satchel's auth and isolation are Supabase specific on purpose. GoTrue issues the JWT, a custom access token hook puts the grant claims in it, and RLS reads them. Replacing that is not in scope. Running it locally is, and the container exists so deploying somewhere other than Vercel stays possible rather than becoming a rewrite.

## What is not verified here

The `Dockerfile`, `compose.yaml` and `supabase/config.toml` in this repository have not been run: there is no Supabase CLI on the machine they were written on and no Docker daemon. What has been run is `npm run serve`, against the real handlers, and `tests/local-server.test.mjs` covers the routing. Treat the other three as a first draft until someone brings them up.
