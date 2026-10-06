import { Sentence } from '../../client';
import type { Schedule } from './schedule.mjs';

// The browser half of giving the overnight pass its own connection.
//
// It is the same flow the plugin runs for its hooks (integrations/shared/auth.mjs):
// register a client once, send the person through Satchel's own consent page
// with PKCE, and swap the code for a refresh token. The difference is where
// the redirect lands. A script listens on a loopback port; this lands on a
// page of ours, /settings/consolidation.
//
// What is kept, and where:
//   localStorage    the client id and the redirect it was registered for. An id,
//                   not a secret. Registering again for every switch-on would
//                   leave a dead client and a dead row in Apps each time.
//   sessionStorage  the PKCE verifier, the state, and the schedule chosen, for
//                   the length of one round trip. Gone when the tab closes.
//   nowhere         the refresh token. It lives in a variable between the token
//                   exchange and the call that hands it to the Vault.
const ISSUER = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1`;
const CALLBACK = '/settings/consolidation';
const SCOPE = 'openid offline_access';
const CLIENT_KEY = 'satchel.consolidation.client';
const PENDING_KEY = 'satchel.consolidation.pending';
export const CLIENT_NAME = 'Satchel consolidation';

type Pending = { verifier: string; state: string; clientId: string; redirectUri: string; schedule: Schedule };

const redirectUri = () => `${location.origin}${CALLBACK}`;

/** Where the database posts the stored token. Pinned to the deployment's own
 *  public address when it is configured, and the page's address otherwise. The
 *  database refuses anything that is not https and this path, because that
 *  address is where a long-lived credential is sent. */
export const consolidationEndpoint = () =>
  `${String(import.meta.env.VITE_SATCHEL_PUBLIC_URL ?? location.origin).replace(/\/+$/, '')}/api/consolidate`;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (length: number) => base64url(crypto.getRandomValues(new Uint8Array(length)));

/** The client this browser registered for this address, if it did. The consent
 *  page uses it to tell the overnight pass from an app that merely shares its name. */
export function rememberedClientId(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CLIENT_KEY) ?? 'null');
    return saved?.redirectUri === redirectUri() && typeof saved?.clientId === 'string' ? saved.clientId : null;
  } catch { return null; }
}

async function registeredClient(): Promise<string> {
  const known = rememberedClientId();
  if (known) return known;
  const response = await fetch(`${ISSUER}/oauth/clients/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME, application_type: 'web', redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', client_uri: location.origin,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Sentence('Satchel could not set up the overnight sign-in. Nothing was switched on. Try again in a minute.');
  const client = await response.json();
  if (typeof client?.client_id !== 'string') throw new Sentence('Satchel could not set up the overnight sign-in. Nothing was switched on.');
  try { localStorage.setItem(CLIENT_KEY, JSON.stringify({ clientId: client.client_id, redirectUri: redirectUri() })); }
  catch { /* It still works. It registers again next time. */ }
  return client.client_id;
}

/** Sends the person to the consent page. Does not return when it works. */
export async function beginEnable(schedule: Schedule): Promise<void> {
  // Before registering anything: a localhost page cannot be reached from the
  // database, so a pass switched on there would only fail three times and stop.
  if (!consolidationEndpoint().startsWith('https://'))
    throw new Sentence('The overnight pass can only be switched on from the hosted Satchel, over https. Open it there.');
  const clientId = await registeredClient();
  const verifier = random(48);
  const state = random(24);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const pending: Pending = { verifier, state, clientId, redirectUri: redirectUri(), schedule };
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)); }
  catch { throw new Sentence('This browser would not let Satchel remember the sign-in between pages. Allow site data for this page and try again.'); }
  const url = new URL(`${ISSUER}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: pending.redirectUri,
    scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256',
  })) url.searchParams.set(key, value);
  location.assign(url.href);
}

export type Finished = { clientId: string; refreshToken: string; schedule: Schedule };

/** Reads what came back on the callback address and swaps the code for a refresh token. */
export async function finishEnable(params: URLSearchParams): Promise<Finished> {
  let pending: Pending | null = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null'); } catch { /* Treated as expired. */ }
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* Nothing to remove. */ }
  if (params.get('error')) throw new Sentence('You did not allow it, so the overnight pass was not switched on.');
  if (!pending) throw new Sentence('That sign-in has expired. Switch the overnight pass on again.');
  const code = params.get('code');
  if (params.get('state') !== pending.state || !code)
    throw new Sentence('That response did not match this request, so nothing was switched on. Try again.');
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri,
      client_id: pending.clientId, code_verifier: pending.verifier,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.refresh_token !== 'string')
    throw new Sentence('Satchel could not finish signing the overnight pass in. Nothing was switched on. Try again.');
  return { clientId: pending.clientId, refreshToken: body.refresh_token, schedule: pending.schedule };
}
