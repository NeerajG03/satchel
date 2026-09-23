// The two endpoints the hook scripts call.
//
// Hooks were mcp_tool calls until 0.3.0, which meant the host made them on the
// plugin's behalf, using the agent's own MCP connection. That had one fault
// that could not be worked around: an mcp_tool hook only runs once the
// session's MCP servers are up, and SessionStart at launch fires before that
// point. The host skipped it every time and logged
//
//   mcp_tool hooks are not available for the 'SessionStart' hook event
//   (no MCP client context)
//
// so the one event that most needed memory was the one event that never got
// it. --continue and --resume count as launch too. Everything else about the
// design was fine; that one was fatal, and it is not fixable from this side.
//
// A command script can run at launch. It just needs its own credential, which
// is what integrations/shared/auth.mjs is. So the hooks became scripts, and
// these are the endpoints they call.
//
//   POST /api/hook-index      session start, clear, compact, resume
//   POST /api/hook-retrieve   every prompt
//   POST /api/hook-capture    end of a turn
//   POST /api/consolidate     the background pass, on whatever schedule
//
// Split into two functions rather than one with a `kind` because they have very
// different weights. The index needs jose and supabase-js. Capture needs the
// router, which means `ai` and the model packages behind it. One endpoint would
// have made every session start pay the router's cold start.
import {createClient} from '@supabase/supabase-js';
import {SUPABASE_URL} from './identity.mjs';
import {verifyAgentToken, verifyCompanionToken, CHALLENGE, exchangeRefreshToken} from './agent-token.mjs';
import {memoryService} from './memory-service.mjs';
import {sessionStart, retrieve, capture} from './lifecycle.mjs';
import {consolidatePending} from './consolidation.mjs';

const MAX_BYTES = 256 * 1024;
const sessionPattern = /^[A-Za-z0-9_-]{1,200}$/;
const repositoryPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const EVENTS = new Set(['SessionStart', 'PostCompact']);

/** Vercel hands over parsed JSON, so Content-Length is not a sufficient size
 *  control on its own: the parsed object is re-measured here. Same reasoning as
 *  parseRepositoryHint, which learned it the hard way. */
export function parseHookBody(body, allowed) {
  let value = body;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw Error('Too large');
    value = JSON.parse(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid');
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw Error('Invalid'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw Error('Too large');
  if (Object.keys(value).some(key => !allowed.has(key))) throw Error('Invalid');
  return value;
}

const readSession = value => {
  if (typeof value !== 'string' || !sessionPattern.test(value)) throw Error('Invalid session');
  return value;
};
/** Absent and unlinked are the same answer here, so anything that is not a
 *  normalized owner/name is simply no repository rather than a 400. The script
 *  normalizes before sending; this is the check, not the normalizer. */
const readRepository = value => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text.length <= 201 && repositoryPattern.test(text) ? text : null;
};

/** Everything both endpoints do before they differ. Returns null once it has
 *  answered the request itself.
 *
 *  `allowRefresh` is the one caller that cannot hold a bearer token: the
 *  scheduled job, which runs inside the database and has no session. It sends
 *  the refresh token from the owner's own Vault and this exchanges it, so
 *  everything after is an ordinary access token under ordinary RLS. Only
 *  /api/consolidate allows it; a hook that accepted a refresh token would be
 *  a second way in for no reason. */
async function connect(req, res, {embedder = null, router = null, allowRefresh = false,
  allowCompanion = false, exchange = exchangeRefreshToken} = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
  if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); res.end(); return null; }
  if (Number(req.headers['content-length'] ?? 0) > MAX_BYTES) { res.writeHead(413); res.end(); return null; }
  let token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  let rotated = null;
  if (!token && allowRefresh && typeof req.headers['x-satchel-refresh'] === 'string') {
    try {
      const fresh = await exchange({refreshToken: req.headers['x-satchel-refresh'],
        clientId: String(req.headers['x-satchel-client'] ?? '')});
      token = fresh.accessToken;
      rotated = fresh.refreshToken;
    } catch (error) {
      // The status is what the schedule reads out of pg_net's response log,
      // and three refusals in a row switch the job off. A revoked grant has
      // to stop it rather than be retried forever.
      res.writeHead(error?.status === 400 || error?.status === 401 ? 401 : 503);
      res.end('Consolidation credential refused');
      return null;
    }
  }
  let claims;
  // A person, signed in to their own web app, rather than an app they granted
  // something to. Tried second and only where it is allowed, so a hook can
  // never be reached with a browser session.
  let companion = false;
  try { if (!token) throw Error('Missing token'); claims = await verifyAgentToken(token); }
  catch {
    try {
      if (!allowCompanion || !token) throw Error('Not allowed here');
      claims = await verifyCompanionToken(token);
      companion = true;
    } catch { res.writeHead(401, {'WWW-Authenticate': CHALLENGE}); res.end('Authentication required'); return null; }
  }
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!key) { res.writeHead(503); res.end('Server configuration unavailable'); return null; }
  // The publishable key plus the caller's own token. Every query after this
  // runs as that person under RLS, so a bug in a handler is a failed query
  // rather than a leak.
  const db = createClient(SUPABASE_URL, key, {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
    global: {headers: {Authorization: `Bearer ${token}`}},
  });
  const service = memoryService(db, embedder, router);
  // A grant is what an app has and a person does not. agent_connection_status
  // answers nothing for a companion session, and reading that as "revoked"
  // would refuse the owner from their own account.
  if (!companion) {
    try {
      if (!await service.status()) { res.writeHead(403); res.end('Connection revoked or unavailable'); return null; }
    } catch { res.writeHead(503); res.end('Unable to verify connection'); return null; }
  }
  return {service, rotated, companion, ownerId: typeof claims?.sub === 'string' ? claims.sub : undefined};
}

const clamp = (value, fallback, low, high) => {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.trunc(number), low), high) : fallback;
};

const send = (res, payload) => {
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify(payload));
};

/** Session start. The script sends the session id, why it fired, and the
 *  workspace's normalized git origin; it gets back the exact text to inject
 *  and the one line to show the person. */
export async function handleHookIndex(req, res) {
  const connection = await connect(req, res);
  if (!connection) return;
  let input;
  try { input = parseHookBody(req.body, new Set(['session_key', 'event', 'repository'])); }
  catch { res.writeHead(400); return res.end(); }
  let sessionKey;
  try { sessionKey = readSession(input.session_key); }
  catch { res.writeHead(400); return res.end(); }
  const event = EVENTS.has(input.event) ? input.event : 'SessionStart';
  const result = await sessionStart(connection.service, {
    sessionKey, event, repository: readRepository(input.repository), ownerId: connection.ownerId});
  send(res, {context: result.context, notice: result.notice, active_project: result.active_project});
}

/** Every prompt. The prompt is the search query and nothing else: no
 *  transcript, no assistant text, and the only thing written is the user's own
 *  message into the 24 hour rolling window. */
export async function handleHookRetrieve(req, res, {embedder = null, traced, retrieval} = {}) {
  const connection = await connect(req, res, {embedder});
  if (!connection) return;
  let input;
  try { input = parseHookBody(req.body, new Set(['session_key', 'prompt', 'repository', 'exclude'])); }
  catch { res.writeHead(400); return res.end(); }
  let sessionKey;
  try { sessionKey = readSession(input.session_key); }
  catch { res.writeHead(400); return res.end(); }
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 4000) : '';
  // An empty prompt is not an error, it is a turn with nothing to search for.
  if (!prompt) return send(res, {context: '', notice: ''});
  const exclude = (Array.isArray(input.exclude) ? input.exclude : [])
    .filter(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 50);
  const result = await retrieve(connection.service, {
    sessionKey, prompt, repository: readRepository(input.repository), exclude,
    ownerId: connection.ownerId, ...(traced ? {traced} : {}), ...(retrieval ? {retrieval} : {})});
  send(res, {context: result.context, notice: result.notice});
}

/** The background pass over conversations that have gone quiet.
 *
 *  Authenticated exactly like the hooks, with the credential the plugin
 *  already holds, so whatever ends up running the schedule needs no new kind
 *  of secret and RLS still decides what it can touch. It writes memory and
 *  nothing reads the reply, so the answer is a count rather than context.
 *
 *  Two callers, and they authenticate differently. The six hourly job sends
 *  the refresh token from the owner's Vault, because a scheduler has no
 *  session. A person pressing the button on the activity page sends their own
 *  browser session, because they are right there. Both end up as the same
 *  ordinary access token, and RLS decides the rest either way.
 *
 *  `idle_minutes` and `limit` are arguments rather than constants because the
 *  right values differ: the job sweeps everything that has gone quiet, and a
 *  person pressing a button usually means the session they just finished. */
export async function handleConsolidate(req, res, {embedder = null, consolidator = null, traced,
  exchange} = {}) {
  const connection = await connect(req, res, {embedder, allowRefresh: true, allowCompanion: true,
    ...(exchange ? {exchange} : {})});
  if (!connection) return;
  if (!consolidator) { res.writeHead(503); return res.end('No consolidation model is configured'); }
  let input;
  // A POST with no body at all is the ordinary call, and it is what a cron
  // makes. An empty body is not a malformed one.
  const body = req.body == null || String(req.body).trim() === '' ? {} : req.body;
  // `limit` is still accepted and ignored. The cron and any open browser
  // tab still send it, and refusing it would turn a removed cap into a 400.
  try { input = parseHookBody(body, new Set(['idle_minutes', 'limit'])); }
  catch { res.writeHead(400); return res.end(); }
  const idleMinutes = clamp(input.idle_minutes, 30, 0, 10080);
  // Stored before the work, not after. Supabase rotated the token the moment
  // it was exchanged, so the copy in the Vault is already dead; a run that
  // crashed before writing the new one back would leave the job unable to
  // authenticate ever again.
  if (connection.rotated) await connection.service.rotateConsolidationCredential(connection.rotated);
  const result = await consolidatePending(connection.service, consolidator, {
    idleMinutes, ownerId: connection.ownerId, ...(traced ? {traced} : {})});
  send(res, result);
}

/** The end of a turn. `assistant` is the host's own last_assistant_message.
 *  Nothing is injected back; the reply is the one line the person sees when
 *  something was actually saved. */
export async function handleHookCapture(req, res, {embedder = null, router = null, traced} = {}) {
  const connection = await connect(req, res, {embedder, router});
  if (!connection) return;
  let input;
  try { input = parseHookBody(req.body, new Set(['session_key', 'repository', 'assistant', 'commits'])); }
  catch { res.writeHead(400); return res.end(); }
  let sessionKey;
  try { sessionKey = readSession(input.session_key); }
  catch { res.writeHead(400); return res.end(); }
  const assistant = typeof input.assistant === 'string' ? input.assistant.slice(0, 8000) : '';
  // How many commits the workspace's repository has. Absent, out of range or
  // not a number all mean the same thing: no observation this turn, which is
  // the ordinary case on a non-Git workspace.
  const commits = clamp(input.commits, null, 0, 100_000_000);
  const result = await capture(connection.service, {
    sessionKey, repository: readRepository(input.repository), assistant, commits,
    ownerId: connection.ownerId, ...(traced ? {traced} : {})});
  send(res, {captured: result.captured, notice: result.notice});
}
