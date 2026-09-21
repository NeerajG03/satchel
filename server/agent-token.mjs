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
