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
//   POST /api/hook-index     session start, clear, compact, resume
//   POST /api/hook-capture   end of a turn
//
// Split into two functions rather than one with a `kind` because they have very
// different weights. The index needs jose and supabase-js. Capture needs the
// router, which means `ai` and the model packages behind it. One endpoint would
// have made every session start pay the router's cold start.
import {createClient} from '@supabase/supabase-js';
import {SUPABASE_URL} from './identity.mjs';
import {verifyAgentToken, CHALLENGE} from './agent-token.mjs';
import {memoryService} from './memory-service.mjs';
import {sessionStart, capture} from './lifecycle.mjs';

const MAX_BYTES = 256 * 1024;
const sessionPattern = /^[A-Za-z0-9_-]{1,200}$/;
const repositoryPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const EVENTS = new Set(['SessionStart', 'PostCompact']);
const ROLES = new Set(['user', 'assistant']);

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
 *  answered the request itself. */
async function connect(req, res, {embedder = null, router = null} = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
  if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); res.end(); return null; }
  if (Number(req.headers['content-length'] ?? 0) > MAX_BYTES) { res.writeHead(413); res.end(); return null; }
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  let claims;
  try { if (!token) throw Error('Missing token'); claims = await verifyAgentToken(token); }
  catch { res.writeHead(401, {'WWW-Authenticate': CHALLENGE}); res.end('Authentication required'); return null; }
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
  try {
    if (!await service.status()) { res.writeHead(403); res.end('Connection revoked or unavailable'); return null; }
  } catch { res.writeHead(503); res.end('Unable to verify connection'); return null; }
  return {service, ownerId: typeof claims?.sub === 'string' ? claims.sub : undefined};
}

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

/** The end of a turn. `messages` is what the script read out of the host's
 *  transcript since it last ran: the person's typed messages and the
 *  assistant's plain text. Nothing is injected back; the reply is the one line
 *  the person sees when something was actually saved. */
export async function handleHookCapture(req, res, {embedder = null, router = null, traced} = {}) {
  const connection = await connect(req, res, {embedder, router});
  if (!connection) return;
  let input;
  try { input = parseHookBody(req.body, new Set(['session_key', 'repository', 'messages'])); }
  catch { res.writeHead(400); return res.end(); }
  let sessionKey;
  try { sessionKey = readSession(input.session_key); }
  catch { res.writeHead(400); return res.end(); }
  // Shaped here rather than trusted. The script is ours, but this endpoint is
  // on the open internet behind a bearer token, and "the client validates it"
  // is not a validation.
  const messages = (Array.isArray(input.messages) ? input.messages : [])
    .filter(m => m && ROLES.has(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-40)
    .map(m => ({role: m.role, content: m.content.slice(0, 8000)}));
  const result = await capture(connection.service, {
    sessionKey, repository: readRepository(input.repository), messages,
    ownerId: connection.ownerId, ...(traced ? {traced} : {})});
  send(res, {captured: result.captured, notice: result.notice});
}
