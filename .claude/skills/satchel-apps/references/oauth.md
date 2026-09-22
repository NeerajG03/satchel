# The OAuth path, the token, and the request

## The shape of the whole flow

1. The app registers as an OAuth client with Supabase's authorization server at `https://prpgcrwteepcunizdcut.supabase.co/auth/v1`.
2. It sends the person to Satchel's consent page with an `authorization_id`. `Consent.tsx` reads the client's self-declared name and redirect URI from `auth.oauth.getAuthorizationDetails`.
3. Allow writes the grant row first, then calls `approveAuthorization`. Deny calls `denyAuthorization` and goes straight to the redirect.
4. Supabase mints an access token. The custom hook stamps the audience and the grant generation into it.
5. The app calls `POST /api/mcp` with `Authorization: Bearer <token>`.
6. `handleMcp` verifies the token, builds a Supabase client carrying that same token, checks the connection is alive, and runs the MCP server over it.

The order in step 3 matters. Writing the grant before the approval means a failed approval leaves a grant with no token, which is harmless. The other order would leave a token with no grant, which is a client that authenticates and then fails every call for reasons nobody can see.

## The access-token hook

`public.satchel_access_token_hook(event jsonb)` in `202609110003_agent_connections.sql`, selected in Supabase Auth > Hooks.

It returns the event untouched when there is no `client_id`, so a companion token is never modified. When there is one it:

- looks up the live `grant_id` for `(user_id, client_id)` where `revoked_at is null`,
- sets `aud` to `["authenticated", "https://satchel-pi.vercel.app/api/mcp"]`,
- deletes any incoming `satchel_grant_id` claim and writes the looked-up generation in its place.

Deleting before writing is the point. A client that puts `satchel_grant_id` in its own request cannot keep it. A revoked connection gets a null generation, which matches nothing in either access helper.

The function is `stable security definer` with an empty search path, and `execute` is granted to `supabase_auth_admin` only.

## Verifying the token

`verifyAgentToken` in `server/agent-token.mjs` uses `jose` against the issuer's JWKS and requires all of `exp`, `sub`, `client_id` and `satchel_grant_id`, with `audience` equal to `RESOURCE` and the algorithm limited to ES256 or RS256. A token without a `client_id` is a companion token, and it fails here rather than being treated as an app.

A failure returns 401 with a `WWW-Authenticate` header naming `https://satchel-pi.vercel.app/.well-known/oauth-protected-resource`, which is how a client discovers where to authorize. `api/resource-metadata.mjs` serves that document from the `metadata` constant, so the resource, the issuer and the scopes are written once.

## The per-request client

```js
const db = createClient(SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
  auth: {persistSession:false, autoRefreshToken:false, detectSessionInUrl:false},
  global: {headers: {Authorization: `Bearer ${token}`}},
});
```

The publishable key plus the caller's bearer token. Nothing else. Every query after this runs as that person under RLS, so a bug in a tool handler is a failed query, not a leak.

Then `await service.status()`, which is `agent_connection_status()`. Null means the connection is missing, stale or revoked, and the request ends in a 403 before any tool runs. A throw ends in 503, because "we could not check" is not the same answer as "you may not".

The embedder and the router are built once per process, both in a `try` that leaves them null. Missing embedder means retrieval reports itself unavailable and saves still work. Missing router key means capture does not happen. Both are the behaviour Satchel had before those features existed, which is the right degradation.

`flush()` runs in a `finally`. A serverless function can freeze the moment it responds, so a batched trace exporter would lose its spans.

Only `claims.sub` reaches the MCP server, as `ownerId`. Never an email, never the token.

## One person, up to three OAuth clients

Each is its own `agent_connections` row with its own grant and its own Revoke button:

| client | who registers it | holds |
|---|---|---|
| the agent's | Claude Code or Codex, through `/api/mcp` discovery | the host's own token, which Satchel never reads |
| the hook scripts' | `integrations/shared/auth.mjs`, dynamic registration | `~/.satchel/credentials.json`, mode 0600 |
| the consolidation job's | `scripts/enable-consolidation.mjs`, developer only | a refresh token in Supabase Vault |

Revoking one leaves the others alone, which is the reason they are separate.

## `/api/consolidate` and its three credentials

`connect()` in `server/hook-handler.mjs` takes `allowRefresh` and `allowCompanion`, and only `handleConsolidate` passes either.

- **An agent bearer**, verified exactly as above. The hook credential works here.
- **A companion session**, from the web app's button. `verifyCompanionToken` checks issuer, `aud=authenticated` and the algorithm, and **refuses any token carrying `client_id`**, so an app cannot pass itself off as the person. `agent_connection_status()` answers nothing for a companion session, so that check is skipped for this caller rather than read as "revoked".
- **`x-satchel-refresh`**, from `private.run_consolidation` through `pg_net`. `exchangeRefreshToken` trades it at the token endpoint for an access token, `rotate_consolidation_credential` writes the new refresh token back to Vault **before** the work runs (the old one is dead from the moment it was exchanged), and the request then runs as that person under RLS. Three refusals in a row switch the job off, read from pg_net's own response log on the next tick, because a caller whose credential was refused has no session to report from.

Every one of the three ends in the same thing: a Supabase client carrying a token for that person, and RLS deciding every row.

## CORS and method handling

`Cache-Control: no-store` on every response. `OPTIONS` answers 204 with the allowed headers, anything other than `POST` answers 405. `WWW-Authenticate` is in `Access-Control-Expose-Headers`, otherwise a browser client cannot read the challenge it needs.

## The repository hint bridge

`POST /api/repository-hint` is the one anonymous endpoint, and it exists because the plugin's local bootstrap can read the workspace's Git origin but holds no token. `parseRepositoryHint` in `server/repository-hint-handler.mjs` accepts exactly three fields, rejects anything over 1024 bytes twice (the header and the re-serialized object, because Vercel hands over parsed JSON), requires `provider` to be `github`, and pattern-checks the session key and the `owner/repo` shape. It calls `stage_agent_repository_hint` with the publishable key and no user token; the authenticated lifecycle hook is what consumes the staged row later. See the `satchel-projects` skill for what the hint then does.

## The consent and Apps screens

Both are covered in `references/grants.md`, because the controls on them are the grant columns. The one thing to keep here: `Connected.tsx` pulls the return URL out of `sessionStorage`, checks it matches `^https?://`, and redirects after 1.5 seconds. If the stash is missing the page still works and offers Back to Apps. Never redirect to a URL that has not been through that test.

## When the deployment moves

`RESOURCE` and `SUPABASE_URL` in `http-handler.mjs`, the audience literal inside the SQL hook, the URL in `bootstrap.mjs`, and the `.mcp.json` URL in `scripts/build-plugins.mjs` are the same deployment written in four places. They move together or discovery and token verification break apart. `tests/mcp.test.mjs` and `tests/agent-connections.test.mjs` are what catch it.
