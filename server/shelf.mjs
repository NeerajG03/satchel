// The Shelf's two server jobs: read a dropped item into words, and search them.
//
// Both run as the person, on their own session token, under RLS. The token is
// checked as a companion session before anything is spent: an app token never
// reaches the Shelf, and a model call is only made for an item the person's
// own token could read back.
import {createClient} from '@supabase/supabase-js';
import {fetchPreview} from './link-preview.mjs';
import {generateText} from 'ai';
import {SUPABASE_URL} from './identity.mjs';
import {verifyCompanionToken, CHALLENGE} from './agent-token.mjs';
import {providerFor, asBaseUrl} from './model-provider.mjs';
import {shelfDescribePrompt} from './prompt-store.mjs';
import {toVectorLiteral} from './vector.mjs';

// A note of 4000 characters, in any script, with room for the rest of the request.
const MAX_BYTES = 16384;
const QUERY_CHARS = 300;
// Under the function's 60 seconds, with room to answer. What the later steps
// keep back from the earlier ones: the embed and save, and a sort.
const REQUEST_MS = 52000;
const EMBED_MS = 10000;
const SORT_MS = 12000;
const MIN_CALL_MS = 5000;
export const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Measured on the Shelf bench, 2 Nov: where gemini-embedding-001 at 768 did
// best at finding the item while staying quiet when nothing fit.
const SHELF_GATE = Number(process.env.SATCHEL_SHELF_GATE ?? 0.63);

export function createDescriber({
  model = process.env.SATCHEL_SHELF_MODEL ?? 'gemini-3.8-flash',
  provider = process.env.SATCHEL_ROUTER_PROVIDER ?? 'google',
  baseURL = asBaseUrl(process.env.SATCHEL_ROUTER_URL),
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY,
  // A photo or a minute of voice, read while the person watches the card.
  timeoutMs = Number(process.env.SATCHEL_SHELF_TIMEOUT_MS ?? 45000),
  promptResolver = shelfDescribePrompt,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) return null;
  const languageModel = providerFor({provider, apiKey, baseURL, fetchImpl}).languageModel(model);
  return {
    model,
    async describe({bytes, mimeType, note, timeoutMs: limit = timeoutMs}) {
      const {text: system} = await promptResolver();
      const {text} = await generateText({
        model: languageModel, system, temperature: 0, maxRetries: 1,
        abortSignal: AbortSignal.timeout(limit),
        messages: [{role: 'user', content: [
          {type: 'file', data: bytes, mediaType: mimeType},
          {type: 'text', text: note ? `The person's note: ${note}` : 'No note was typed with it.'},
        ]}],
        telemetry: {functionId: 'shelf-describe', metadata: {mimeType}},
      });
      const description = text.trim().slice(0, 4000);
      if (!description) throw Error('The model returned no description');
      return description;
    },
  };
}

/** What search matches: the person's words first, then what was read off the item. */
export const shelfText = ({note, description, transcript}) =>
  [note, transcript, description].map(s => (s ?? '').trim()).filter(Boolean).join('\n');

/**
 * Sorts a read item: profile, topic and suggestions, saved once. The person's
 * own words (their note, or what they said) go on as a one-turn conversation
 * record, so the consolidation pass, the one writer of memories, can learn
 * from them. Satchel's description of a photo is never sent on that way.
 */
export async function sortItem(db, sorter, {item, description, transcript, now = new Date(), calendar = null, timeoutMs}) {
  const {data: context, error} = await db.rpc('shelf_sort_context');
  if (error) throw error;
  const timezone = context?.timezone || 'UTC';
  // The week ahead, from every calendar and list that can be read: it helps place "the
  // standup" and keeps a suggestion from repeating what is already there.
  // Capped, so a slow calendar never costs the sort itself.
  const week = typeof calendar === 'function'
    ? await Promise.race([calendar(timezone).catch(() => null), new Promise(done => setTimeout(done, 4000, null))])
    : calendar;
  const {data: lists} = await db.rpc('shelf_list_names');
  const result = await sorter.sort({item: {kind: item.kind, note: item.note, transcript, description},
    topics: context?.topics ?? [], lists: Array.isArray(lists) ? lists : [], timezone, now, calendar: week, timeoutMs});
  const {data: added, error: saveError} = await db.rpc('save_shelf_sorting', {p_id: item.id, p_profile: result.profile,
    p_topic_id: result.topic_id, p_transcript: transcript, p_suggestions: result.suggestions});
  if (saveError) throw saveError;
  // The books, films and places it names go on their lists. Best effort: the
  // sort itself is saved either way.
  const {data: lined} = await db.rpc('save_shelf_wants', {p_item: item.id, p_wants: result.wants ?? []});
  // An app's note is sorted like any drop, but its words are the app's, not the
  // person's, so they never reach the memory pass.
  const words = item.added_by ? '' : [item.note, transcript].map(s => (s ?? '').trim()).filter(Boolean).join('\n');
  if (words) await db.rpc('record_document_turn', {p_session_key: `shelf-${item.id}`, p_role: 'user', p_content: words,
    p_topic_id: result.topic_id});
  return {suggestions: added ?? 0, profile: result.profile, lines: lined ?? 0};
}

/**
 * The one-time pass over drops sorted before lists existed: the same sorting
 * call, keeping only the list lines. Profile, topic and to-dos stay as they were.
 */
export async function listItem(db, sorter, {item, timeoutMs}) {
  const [{data: context}, {data: lists}] = await Promise.all([db.rpc('shelf_sort_context'), db.rpc('shelf_list_names')]);
  const result = await sorter.sort({item: {kind: item.kind, note: item.note, transcript: item.transcript, description: item.description},
    topics: context?.topics ?? [], lists: Array.isArray(lists) ? lists : [], timezone: context?.timezone || 'UTC', now: new Date(), calendar: null, timeoutMs});
  const {data: lined, error} = await db.rpc('save_shelf_wants', {p_item: item.id, p_wants: result.wants ?? []});
  if (error) throw error;
  return lined ?? 0;
}

export async function personFor(req, res, makeClient, verify) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); res.end(); return null; }
  if (Number(req.headers['content-length'] ?? 0) > MAX_BYTES) { res.writeHead(413); res.end(); return null; }
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  let claims;
  try { if (!token) throw Error('Missing token'); claims = await verify(token); }
  catch { res.writeHead(401, {'WWW-Authenticate': CHALLENGE}); res.end('Sign in to the web app to use the Shelf'); return null; }
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!key) { res.writeHead(503); res.end('Server configuration unavailable'); return null; }
  const db = makeClient(SUPABASE_URL, key, {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
    global: {headers: {Authorization: `Bearer ${token}`}},
  });
  // Who the verified token belongs to, for sealing anything that is theirs.
  db.ownerId = claims?.sub;
  return db;
}

export function readBody(body) {
  let value = body;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid body');
  return value;
}

export const send = (res, status, body) => {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
};

/** POST {action:'describe', id} reads one item, {action:'preview', url} reads a link's preview, {action:'sort', id} sorts a read one, {action:'edit', id, note} changes its note, {action:'lists', id} finds list lines in an old one, {action:'search', q} searches. */
export async function handleShelf(req, res, {embedder, describer, sorter = null, calendar = null, makeClient = createClient,
  verify = verifyCompanionToken, preview = fetchPreview} = {}) {
  const db = await personFor(req, res, makeClient, verify);
  if (!db) return;
  let body;
  try { body = readBody(req.body); } catch { return send(res, 400, {error: 'Satchel could not read that request.'}); }
  if (body.action === 'preview') {
    if (typeof body.url !== 'string' || body.url.length > 2048) return send(res, 400, {error: 'Satchel could not read that link.'});
    return send(res, 200, {preview: await preview(body.url)});
  }
  if (!embedder) return send(res, 503, {error: 'Search is not set up on this server, so nothing was read.'});

  if (body.action === 'search') {
    const q = typeof body.q === 'string' ? body.q.trim().slice(0, QUERY_CHARS) : '';
    if (!q) return send(res, 400, {error: 'Type something to search for.'});
    let vector;
    try { vector = await embedder.embedQuery(q); }
    catch { return send(res, 503, {error: 'Search is busy right now. Try again in a minute.'}); }
    const {data, error} = await db.rpc('search_shelf', {
      p_query: toVectorLiteral(vector), p_model: embedder.model, p_limit: 20, p_gate: SHELF_GATE,
    });
    if (error) return send(res, 502, {error: 'Satchel could not search your Shelf. Reload and try again.'});
    return send(res, 200, {items: data});
  }

  if (body.action === 'edit') {
    if (typeof body.id !== 'string' || !idPattern.test(body.id) || typeof body.note !== 'string' || body.note.length > 4000)
      return send(res, 400, {error: 'Satchel could not read that request.'});
    const {data: rows, error} = await db.rpc('read_shelf_item', {p_id: body.id});
    const item = rows?.[0];
    if (error || !item) return send(res, 404, {error: 'That shelf item is gone. Reload the Shelf.'});
    if (!['ready', 'failed'].includes(item.status)) return send(res, 409, {error: 'Satchel is still reading this one. Try again in a moment.'});
    const note = body.note.trim();
    if (item.kind === 'note' && !note) return send(res, 400, {error: 'A note needs some words. Remove it instead if it is not needed.'});
    let vector = null;
    if (item.status === 'ready') {
      try { vector = await embedder.embedOne(shelfText({note, description: item.description, transcript: item.transcript})); }
      catch { return send(res, 503, {error: 'Search is busy right now, so the note was not changed. Try again in a minute.'}); }
    }
    const {error: saveError} = await db.rpc('edit_shelf_note', {p_id: item.id, p_note: note,
      p_embedding: vector ? toVectorLiteral(vector) : null, p_embedding_model: vector ? embedder.model : null});
    if (saveError) return send(res, 409, {error: 'That one changed or went while you were editing. Reload the Shelf.'});
    return send(res, 200, {id: item.id, note});
  }

  if (body.action === 'lists') {
    if (typeof body.id !== 'string' || !idPattern.test(body.id)) return send(res, 400, {error: 'Satchel could not read that request.'});
    if (!sorter) return send(res, 503, {error: 'Sorting is not set up on this server.'});
    const {data: rows, error} = await db.rpc('read_shelf_item', {p_id: body.id});
    const item = rows?.[0];
    if (error || !item) return send(res, 404, {error: 'That shelf item is gone. Reload the Shelf.'});
    if (item.status !== 'ready' || item.wants_at) return send(res, 200, {id: item.id, lines: 0});
    try { return send(res, 200, {id: item.id, lines: await listItem(db, sorter, {item, timeoutMs: REQUEST_MS - 4000})}); }
    catch { return send(res, 502, {error: 'Satchel could not look at this one for lists. It will try again later.'}); }
  }

  if (typeof body.id !== 'string' || !idPattern.test(body.id) || !['describe', 'sort'].includes(body.action))
    return send(res, 400, {error: 'Satchel could not read that request.'});
  // One deadline for the whole request, under the function's 60 seconds, and
  // each model call gets what is left of it. A step that cannot fit is skipped,
  // never started and cut off.
  const deadline = Date.now() + REQUEST_MS;
  const left = (reserve = 0) => deadline - Date.now() - reserve;
  // A file has to be the size its row says: the row's size is what the browser
  // said, capped at 20 MB by the table, and the file is what arrived.
  const download = async (path, size) => {
    const {data: file, error: fileError} = await db.storage.from('shelf').download(path);
    if (fileError || !file) throw fileError ?? Error('No file');
    if (file.size !== size) throw Error('File does not match its row');
    return new Uint8Array(await file.arrayBuffer());
  };
  // The person's own words, spoken: a voice note itself, or one said about a photo.
  const spoken = item => item.kind === 'voice' ? {path: item.object_path, size: item.size_bytes, mime: item.mime_type}
    : item.voice_path ? {path: item.voice_path, size: item.voice_size, mime: item.voice_mime} : null;
  const transcribe = async item => {
    const voice = spoken(item);
    if (!voice || !sorter || left(SORT_MS) <= MIN_CALL_MS) return null;
    const bytes = await download(voice.path, voice.size).catch(() => null);
    return bytes ? sorter.transcribe({bytes, mimeType: voice.mime, timeoutMs: left(SORT_MS)}).catch(() => null) : null;
  };
  const sort = (item, description, transcript) => sorter && left() > MIN_CALL_MS
    ? sortItem(db, sorter, {item, description, transcript, timeoutMs: left(2000),
        calendar: calendar ? timezone => calendar(db, timezone) : null}).catch(() => null)
    : null;

  if (body.action === 'sort') {
    const {data: rows, error} = await db.rpc('read_shelf_item', {p_id: body.id});
    if (error || !rows?.length) return send(res, 404, {error: 'That shelf item is gone. Reload the Shelf.'});
    const item = rows[0];
    if (item.status !== 'ready' || item.sorted_at)
      return send(res, 409, {error: 'This one is not ready to sort, or is already sorted. Reload the Shelf.'});
    if (!sorter) return send(res, 503, {error: 'Sorting is not set up on this server.'});
    let transcript = item.transcript;
    if (!transcript && spoken(item)) transcript = await transcribe(item);
    const sorted = await sort(item, item.description, transcript);
    if (!sorted) return send(res, 502, {error: 'Satchel could not sort this one. Try again in a minute.'});
    return send(res, 200, {id: item.id, profile: sorted.profile, suggestions: sorted.suggestions, lines: sorted.lines, transcript});
  }

  const {data: rows, error} = await db.rpc('claim_shelf_item', {p_id: body.id});
  if (error?.hint === 'satchel:conflict:shelf_reading')
    return send(res, 409, {error: 'Satchel is already reading this one, or has finished. Reload the Shelf to see it.'});
  if (error || !rows?.length) return send(res, 404, {error: 'That shelf item is gone. Reload the Shelf.'});
  const item = rows[0];
  let description = null;
  let transcript = null;
  try {
    if (item.kind !== 'note') {
      if (!describer) throw Error('No model configured');
      // A voice note is its words: written down once, they are what is shown,
      // searched and remembered. A summary is only asked for when that fails.
      transcript = await transcribe(item);
      if (item.kind === 'photo' || !transcript) {
        const bytes = await download(item.object_path, item.size_bytes);
        // What they said about a photo is the context it is read with.
        const note = [item.note, transcript].map(t => (t ?? '').trim()).filter(Boolean).join('\n');
        description = await describer.describe({bytes, mimeType: item.mime_type, note, timeoutMs: Math.max(MIN_CALL_MS, left(EMBED_MS))});
      }
    }
    const vector = await embedder.embedOne(shelfText({note: item.note, description, transcript}));
    const {data: done, error: saveError} = await db.rpc('describe_shelf_item', {
      p_id: item.id, p_description: description, p_embedding: toVectorLiteral(vector), p_embedding_model: embedder.model,
    });
    if (saveError) throw saveError;
    // Best effort: an item that could not be sorted is still saved, read and
    // searchable, and the Shelf offers to sort it later.
    const sorted = await sort(item, description, transcript);
    return send(res, 200, {id: item.id, status: done?.[0]?.status ?? 'ready', description, transcript,
      profile: sorted?.profile ?? null, suggestions: sorted?.suggestions ?? 0, lines: sorted?.lines ?? 0, sorted: Boolean(sorted)});
  } catch {
    // Kept and marked, so the person sees which one did not take and can
    // remove it or drop it again. A failure here is never a lost item.
    await db.rpc('describe_shelf_item', {p_id: item.id, p_description: null, p_embedding: null, p_embedding_model: null});
    return send(res, 502, {error: 'Satchel could not read this one, so it is saved but not searchable. Try dropping it again.'});
  }
}
