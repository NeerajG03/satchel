// The hook scripts' own OAuth connection, separate from the agent's.
//
// The hooks used to be mcp_tool calls, so the host held the credential and the
// scripts held nothing. Scripts need their own, and the tempting shortcut was
// to read the host's token out of the macOS keychain. That is wrong twice: it
// is someone else's credential, and refreshing it rotates the token the host is
// still using, so Satchel would break the agent's own MCP connection.
//
// So this registers as its own OAuth client and runs its own flow. It ends up
// as an ordinary row in agent_connections next to the agent's, with its own
// grant, its own generation, and the same Revoke button in Apps. Nothing about
// authorization is new; there is just a second client.
//
//   agent                            hooks
//   client_id  claude-code-…         client_id  (registered once, stored here)
//   token      host keychain         token      ~/.satchel/credentials.json
//   grant      agent_connections     grant      agent_connections
//   revoke     Apps                  revoke     Apps
//
// The refresh token is what makes this "no expiry": Supabase refresh tokens do
// not age out on their own, so the file keeps working until it is revoked.
// Revocation is the control, not expiry, and that is the honest trade. The file
// is 0600 and holds no memory, only the credential.

import {createHash, randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, rmdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const SATCHEL_URL = process.env.SATCHEL_URL ?? 'https://satchel-pi.vercel.app';
export const ISSUER = process.env.SATCHEL_ISSUER ?? 'https://prpgcrwteepcunizdcut.supabase.co/auth/v1';
// Loopback only, and fixed, because a dynamically registered client has to
// declare its redirect URIs up front. Several so a busy port is not a dead end.
const PORTS = [19876, 19877, 19878, 19879, 19880];
const SCOPE = 'openid offline_access';
// Without offline_access there is no refresh token, and without a refresh token
// this whole design is a one hour credential.

export const satchelHome = () => process.env.SATCHEL_HOME ?? join(homedir(), '.satchel');
const credentialsPath = () => join(satchelHome(), 'credentials.json');

const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function readCredentials() {
  try { return JSON.parse(readFileSync(credentialsPath(), 'utf8')); }
  catch { return null; }
}

/** Written through a temp file and renamed, so a hook that dies mid-write
 *  leaves the previous credential rather than half of the new one. Two hooks
 *  can still race; the loser simply refreshes again next time. */
export function writeCredentials(value) {
  const home = satchelHome();
  mkdirSync(home, {recursive: true, mode: 0o700});
  const target = credentialsPath();
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  renameSync(temporary, target);
  try { chmodSync(target, 0o600); } catch { /* Best effort on filesystems without modes. */ }
  return value;
}

const post = async (url, body, timeout = 10000) => {
  const response = await fetch(url, {
    method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(body), signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* Reported through ok/status below. */ }
  return {ok: response.ok, status: response.status, body: parsed, text};
};

/** Register once and keep the client_id. Re-registering on every flow would
 *  leave a trail of dead clients and a trail of grant rows in Apps, one per
 *  connect, which is a mess the person has to clean up by hand. */
async function registerClient(redirectUris, clientName = 'Satchel Hooks') {
  const response = await fetch(`${ISSUER}/oauth/clients/register`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      client_name: clientName, application_type: 'native',
      redirect_uris: redirectUris, grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
      client_uri: SATCHEL_URL,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error(`Could not register with Satchel (${response.status})`);
  const client = await response.json();
  if (typeof client?.client_id !== 'string') throw Error('Registration returned no client_id');
  return client.client_id;
}

const openBrowser = url => {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(command, args, {stdio: 'ignore', detached: true}).unref(); return true; }
  catch { return false; }
};

const PAGE = message => `<!doctype html><meta charset="utf-8"><title>Satchel</title>`
  + `<body style="font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:32rem;margin:16vh auto;padding:0 1.5rem;color:#1a1a1a">`
  + `<p style="font-size:1.4rem;margin:0 0 .5rem">${message}</p>`
  + `<p style="color:#666;margin:0">You can close this tab and go back to your terminal.</p>`;

/** The interactive half. Opens a browser at Satchel's own consent page and
 *  waits on the loopback listener for the code to come back. */
export async function connect({timeoutMs = 15 * 60 * 1000, open = openBrowser, log = () => {},
  // The background consolidation job runs a second flow for a second client,
  // and it keeps its credential in the owner's database rather than on this
  // machine. These are parameters rather than a copy of this function, because
  // the flow is the part that must not drift: one of these two would end up
  // being the one nobody fixed.
  //
  // `clientId` is how a caller that does not persist here still registers
  // once. Without it every run would create another client and another row in
  // Apps, and turning the job off would register a client purely in order to
  // authenticate the request that turns it off.
  clientName = 'Satchel Hooks', persist = true, clientId: supplied = null} = {}) {
  const existing = persist ? readCredentials() : null;
  const redirectUris = PORTS.map(port => `http://127.0.0.1:${port}/callback`);
  const clientId = supplied ?? existing?.client_id ?? await registerClient(redirectUris, clientName);
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));

  // The listener has to be up before the browser is, or a fast redirect races
  // it and the person sees a connection refused page instead of the consent.
  let port = null;
  const server = createServer();
  for (const candidate of PORTS) {
    try {
      await new Promise((ready, fail) => {
        const onError = error => { server.off('listening', onReady); fail(error); };
        const onReady = () => { server.off('error', onError); ready(); };
        server.once('error', onError);
        server.once('listening', onReady);
        server.listen(candidate, '127.0.0.1');
      });
      port = candidate;
      break;
    } catch { /* Port in use; try the next. */ }
  }
  if (port === null) throw Error(`No free port among ${PORTS.join(', ')}. Close whatever is using them and try again.`);

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorize = new URL(`${ISSUER}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256',
  })) authorize.searchParams.set(key, value);

  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Error('Timed out waiting for the browser. Nothing was changed.')), timeoutMs);
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const failure = url.searchParams.get('error');
      const returned = url.searchParams.get('code');
      const matched = url.searchParams.get('state') === state;
      const message = failure ? 'Satchel was not connected.'
        : !matched ? 'That response did not match this request.'
        : !returned ? 'No authorization code came back.' : 'Satchel is connected.';
      res.writeHead(failure || !matched || !returned ? 400 : 200, {'content-type': 'text/html; charset=utf-8'});
      res.end(PAGE(message));
      finish(failure ? Error(`Authorization was refused (${failure})`)
        : !matched ? Error('The browser response did not match this request')
        : !returned ? Error('No authorization code came back') : null, returned);
    });
    log(`Opening ${authorize.href}`);
    if (!open(authorize.href)) log('Could not open a browser. Paste that link in yourself.');
  });

  const exchanged = await post(`${ISSUER}/oauth/token`, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: clientId, code_verifier: verifier,
  });
  if (!exchanged.ok || typeof exchanged.body?.access_token !== 'string')
    throw Error(`Could not finish signing in (${exchanged.status})`);
  if (typeof exchanged.body.refresh_token !== 'string')
    throw Error('Satchel got a token that cannot be refreshed. offline_access was not granted.');
  const credentials = {
    issuer: ISSUER, client_id: clientId, refresh_token: exchanged.body.refresh_token,
    access_token: exchanged.body.access_token,
    expires_at: Date.now() + Math.max(0, Number(exchanged.body.expires_in ?? 3600) - 60) * 1000,
    connected_at: new Date().toISOString(),
  };
  return persist ? writeCredentials(credentials) : credentials;
}

/** A lock around refresh, because Supabase rotates the refresh token: two
 *  hooks refreshing at once would leave one of them holding a token that has
 *  already been spent. mkdir is the atomic primitive available everywhere. */
async function withLock(fn, {waitMs = 3000, staleMs = 20000} = {}) {
  mkdirSync(satchelHome(), {recursive: true, mode: 0o700});
  const lock = join(satchelHome(), 'refresh.lock');
  const deadline = Date.now() + waitMs;
  let held = false;
  while (Date.now() <= deadline) {
    try { mkdirSync(lock); held = true; break; }
    catch {
      // A hook that died holding the lock leaves the directory behind forever,
      // so an old one is taken rather than waited on.
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmdirSync(lock); continue; } }
      catch { continue; }
      await new Promise(done => setTimeout(done, 50));
    }
  }
  // Giving up on the lock still runs the work. Waiting longer than this inside
  // a hook is worse than two refreshes racing, and the loser just refreshes
  // again on the next turn.
  try { return await fn(held); }
  finally { if (held) { try { rmdirSync(lock); } catch { /* Already gone. */ } } }
}

async function refresh(credentials) {
  const response = await post(`${ISSUER}/oauth/token`, {
    grant_type: 'refresh_token', refresh_token: credentials.refresh_token,
    client_id: credentials.client_id,
  });
  if (!response.ok || typeof response.body?.access_token !== 'string') {
    // A refresh token is rejected when the connection was revoked, which is a
    // real answer and not a failure to retry. Saying so is the difference
    // between "Satchel is broken" and "you revoked this in Apps".
    const revoked = response.status === 400 || response.status === 401;
    throw Object.assign(Error(revoked
      ? 'Satchel is not connected any more. Run satchel connect to reconnect.'
      : `Satchel could not refresh its token (${response.status})`), {revoked});
  }
  return writeCredentials({
    ...credentials,
    refresh_token: typeof response.body.refresh_token === 'string' ? response.body.refresh_token : credentials.refresh_token,
    access_token: response.body.access_token,
    expires_at: Date.now() + Math.max(0, Number(response.body.expires_in ?? 3600) - 60) * 1000,
  });
}

/** The one call the hook scripts make. Returns a usable access token, or null
 *  when there is no connection at all, which is not an error: it is a Satchel
 *  that has not been set up yet, and the hooks have to stay quiet about it
 *  rather than failing a session. */
export async function accessToken() {
  const credentials = readCredentials();
  if (!credentials?.refresh_token) return null;
  if (typeof credentials.access_token === 'string' && Number(credentials.expires_at) > Date.now())
    return credentials.access_token;
  return withLock(async () => {
    // Re-read inside the lock: another hook may have refreshed while this one
    // waited, and spending a rotated refresh token is what that race costs.
    const current = readCredentials() ?? credentials;
    if (typeof current.access_token === 'string' && Number(current.expires_at) > Date.now())
      return current.access_token;
    if (!current.refresh_token) return null;
    return (await refresh(current)).access_token;
  });
}

/** Both hook scripts talk to Satchel through this and nothing else. */
export async function call(path, body, {timeout = 8000} = {}) {
  const token = await accessToken();
  if (!token) return {connected: false};
  const response = await fetch(new URL(path, SATCHEL_URL), {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) return {connected: true, ok: false, status: response.status};
  return {connected: true, ok: true, data: await response.json()};
}
