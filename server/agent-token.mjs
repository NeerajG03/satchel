// Verifying a bearer token, and nothing else.
//
// This was inside http-handler.mjs, which also builds the MCP server, the
// Supabase client, the embedder and the router. Every endpoint that needs to
// check a token was paying for all of that, and identity.mjs already exists for
// exactly this reason: a small thing that a cheap endpoint needs should not
// drag the model stack in behind it.
//
// /api/hook-index is the one that cares. It runs on every session start, it
// has a short budget, and it needs jose and supabase-js and nothing more.
import {createRemoteJWKSet, jwtVerify} from 'jose';
import {RESOURCE, ISSUER} from './identity.mjs';

const keys = createRemoteJWKSet(new URL(ISSUER + '/.well-known/jwks.json'));

/** A token without client_id is a companion session, not an app, and it fails
 *  here rather than being treated as one. satchel_grant_id is the revocation
 *  generation: the access-token hook stamps it, and every access check compares
 *  it, so a revoked connection cannot come back with an old token. */
export async function verifyAgentToken(token, verificationKeys = keys) {
  const {payload} = await jwtVerify(token, verificationKeys, {
    issuer: ISSUER, audience: RESOURCE, algorithms: ['ES256', 'RS256'],
    requiredClaims: ['exp', 'sub', 'client_id', 'satchel_grant_id'],
  });
  if (typeof payload.client_id !== 'string' || typeof payload.satchel_grant_id !== 'string')
    throw Error('Missing grant');
  return payload;
}

export const CHALLENGE = `Bearer resource_metadata="https://satchel-pi.vercel.app/.well-known/oauth-protected-resource", scope="openid"`;

/** A refresh token for an access token, for the one caller that cannot hold a
 *  bearer one: the six hourly consolidation job.
 *
 *  It lives in the owner's own Vault and pg_net sends it, because a scheduled
 *  job inside the database has no session and the alternative is handing a
 *  background writer a blanket key. The access token it gets back is an
 *  ordinary one and everything after this point runs under RLS exactly like a
 *  hook.
 *
 *  Supabase rotates on use, so the new refresh token comes back here and the
 *  caller has to store it. Without that the job works exactly once. */
export async function exchangeRefreshToken({refreshToken, clientId, issuer = ISSUER,
  fetchImpl = fetch, timeoutMs = 8000} = {}) {
  if (!refreshToken || !clientId) throw Error('Missing refresh credential');
  const response = await fetchImpl(`${issuer}/oauth/token`, {
    method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try { body = await response.json(); } catch { /* Reported as a refusal below. */ }
  // A refused refresh is a revoked grant far more often than a bad request,
  // and either way the answer is the same: this job is over until someone
  // turns it on again. The status travels so the caller can say which.
  if (!response.ok || typeof body?.access_token !== 'string')
    throw Object.assign(Error(`Refresh refused (${response.status})`), {status: response.status});
  return {
    accessToken: body.access_token,
    // Rotation can be off, in which case the token that came in is still the
    // one to keep. Returning it unconditionally means the caller stores
    // something correct either way.
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
  };
}
