import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleShelf, shelfText} from '../server/shelf.mjs';

process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= 'test-publishable';
const id = '40000000-0000-4000-8000-000000000001';

function fakeRes() {
  const res = {status: 0, headers: {}, body: ''};
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (status, headers = {}) => { res.status = status; Object.assign(res.headers, headers); };
  res.end = body => { res.body = body ?? ''; };
  return res;
}
const req = (body, token = 'person') => ({method: 'POST', headers: token ? {authorization: `Bearer ${token}`} : {}, body});
const verify = async token => { if (token !== 'person') throw Error('bad'); return {sub: 'alice'}; };

function fakeDb({item, fileError = null}) {
  const calls = [];
  const db = {
    calls,
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'claim_shelf_item') return item === 'busy' ? {data: null, error: {hint: 'satchel:conflict:shelf_reading'}}
        : item ? {data: [item], error: null} : {data: null, error: {message: 'gone'}};
      if (name === 'describe_shelf_item') return {data: [{id: args.p_id, status: args.p_embedding ? 'ready' : 'failed'}], error: null};
      if (name === 'search_shelf') return {data: [{id, similarity: 0.8}], error: null};
      return {data: null, error: {message: 'unknown'}};
    },
    storage: {from: bucket => ({download: async path => {
      calls.push(['download', bucket, path]);
      return fileError ? {data: null, error: fileError} : {data: new Blob([new Uint8Array([1, 2, 3])]), error: null};
    }})},
  };
  return db;
}
const embedder = {model: 'm', embedOne: async () => [1, 0], embedQuery: async () => [0, 1]};

test('a photo is read, embedded with its note, and marked ready', async () => {
  const db = fakeDb({item: {id, kind: 'photo', note: 'toit', object_path: `alice/${id}.jpg`, mime_type: 'image/jpeg', size_bytes: 3}});
  let seen;
  const describer = {describe: async input => { seen = input; return 'Receipt from Toit, total 2340.'; }};
  const res = fakeRes();
  await handleShelf(req({action: 'describe', id}), res, {embedder, describer, makeClient: () => db, verify});
  assert.equal(res.status, 200);
  assert.equal(seen.mimeType, 'image/jpeg');
  assert.deepEqual([...seen.bytes], [1, 2, 3]);
  assert.deepEqual(db.calls.find(c => c[0] === 'download'), ['download', 'shelf', `alice/${id}.jpg`]);
  const saved = db.calls.find(c => c[0] === 'describe_shelf_item')[1];
  assert.equal(saved.p_description, 'Receipt from Toit, total 2340.');
  assert.equal(saved.p_embedding_model, 'm');
});

test('a note needs no model call', async () => {
  const db = fakeDb({item: {id, kind: 'note', note: 'call the dentist', object_path: null, mime_type: null}});
  const describer = {describe: async () => { throw Error('should not be called'); }};
  const res = fakeRes();
  await handleShelf(req({action: 'describe', id}), res, {embedder, describer, makeClient: () => db, verify});
  assert.equal(res.status, 200);
  assert.equal(db.calls.find(c => c[0] === 'describe_shelf_item')[1].p_description, null);
});

test('a failed read keeps the item and marks it failed', async () => {
  const db = fakeDb({item: {id, kind: 'voice', note: '', object_path: `alice/${id}.webm`, mime_type: 'audio/webm', size_bytes: 3}});
  const describer = {describe: async () => { throw Error('model down'); }};
  const res = fakeRes();
  await handleShelf(req({action: 'describe', id}), res, {embedder, describer, makeClient: () => db, verify});
  assert.equal(res.status, 502);
  const marked = db.calls.filter(c => c[0] === 'describe_shelf_item').at(-1)[1];
  assert.equal(marked.p_embedding, null);
});

test('nothing is spent for a token that is not a signed-in person', async () => {
  let made = false;
  const res = fakeRes();
  await handleShelf(req({action: 'search', q: 'receipt'}, 'an-app-token'), res, {embedder, makeClient: () => { made = true; }, verify});
  assert.equal(res.status, 401);
  assert.equal(made, false);
  const none = fakeRes();
  await handleShelf(req({action: 'search', q: 'x'}, null), none, {embedder, makeClient: () => { made = true; }, verify});
  assert.equal(none.status, 401);
});

test('an item the person cannot read is a 404 and calls no model', async () => {
  const db = fakeDb({item: null});
  const describer = {describe: async () => { throw Error('should not be called'); }};
  const res = fakeRes();
  await handleShelf(req({action: 'describe', id}), res, {embedder, describer, makeClient: () => db, verify});
  assert.equal(res.status, 404);
  assert.equal(db.calls.some(c => c[0] === 'download'), false);
});

test('an item already read, or being read, is a 409 and calls no model', async () => {
  const db = fakeDb({item: 'busy'});
  const describer = {describe: async () => { throw Error('should not be called'); }};
  const res = fakeRes();
  await handleShelf(req({action: 'describe', id}), res, {embedder, describer, makeClient: () => db, verify});
  assert.equal(res.status, 409);
  assert.equal(db.calls.some(c => c[0] === 'download'), false);
});

test('a file that does not match its row never reaches the model', async () => {
  const db = fakeDb({item: {id, kind: 'photo', note: '', object_path: `alice/${id}.jpg`, mime_type: 'image/jpeg', size_bytes: 999}});
  const describer = {describe: async () => { throw Error('should not be called'); }};
  const res = fakeRes();
  await handleShelf(req({action: 'describe', id}), res, {embedder, describer, makeClient: () => db, verify});
  assert.equal(res.status, 502);
});

test('search sends the query vector with the model name and the measured gate', async () => {
  const db = fakeDb({});
  const res = fakeRes();
  await handleShelf(req({action: 'search', q: '  where did I park  '}), res, {embedder, makeClient: () => db, verify});
  assert.equal(res.status, 200);
  const [, args] = db.calls.find(c => c[0] === 'search_shelf');
  assert.equal(args.p_query, '[0,1]');
  assert.equal(args.p_model, 'm');
  assert.equal(args.p_gate, 0.63);
});

test('bad requests are refused before any work', async () => {
  for (const body of [{action: 'describe', id: 'not-a-uuid'}, {action: 'search', q: '   '}, {action: 'other'}, '[]']) {
    const res = fakeRes();
    await handleShelf(req(body), res, {embedder, makeClient: () => fakeDb({}), verify});
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const get = fakeRes();
  await handleShelf({method: 'GET', headers: {}}, get, {embedder, verify});
  assert.equal(get.status, 405);
});

test('search text is the note, then the description', () => {
  assert.equal(shelfText({note: ' toit ', description: 'Receipt.'}), 'toit\nReceipt.');
  assert.equal(shelfText({note: '', description: null}), '');
});

test('a voice note is transcribed, not summarised, before it is embedded, and a failed sort still answers 200', async () => {
  const db = fakeDb({item: {id, kind: 'voice', note: '', object_path: `alice/${id}.m4a`, mime_type: 'audio/mp4', size_bytes: 3}});
  const order = [];
  const describer = {describe: async () => { order.push('describe'); return 'Voice note about parking.'; }};
  const sorter = {
    transcribe: async () => { order.push('transcribe'); return 'parked on level two'; },
    sort: async () => { order.push('sort'); throw Error('model down'); },
  };
  const embedding = {model: 'm', embedOne: async text => { order.push(`embed:${text}`); return [1, 0]; }, embedQuery: async () => [0, 1]};
  const realRpc = db.rpc;
  db.rpc = async (name, args) => name === 'shelf_sort_context' ? {data: {timezone: 'UTC', topics: []}, error: null} : realRpc(name, args);
  const res = fakeRes();
  await handleShelf(req({action: 'describe', id}), res, {embedder: embedding, describer, sorter, makeClient: () => db, verify});
  assert.equal(res.status, 200);
  assert.deepEqual(order, ['transcribe', 'embed:parked on level two', 'sort'], 'one audio call: no summary when the words came back');
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ready');
  assert.equal(body.sorted, false);
});

test('sort sorts a read, unsorted item, and refuses one already sorted', async () => {
  const read = {id, kind: 'note', note: 'call the dentist tuesday', object_path: null, mime_type: null, size_bytes: null,
    description: null, transcript: null, status: 'ready', sorted_at: null};
  let current = read;
  const calls = [];
  const db = {rpc: async (name, args) => {
    calls.push(name);
    if (name === 'read_shelf_item') return {data: [current], error: null};
    if (name === 'shelf_sort_context') return {data: {timezone: 'UTC', topics: []}, error: null};
    if (name === 'save_shelf_sorting') return {data: 1, error: null};
    return {data: null, error: null};
  }};
  const sorter = {transcribe: async () => null, sort: async () => ({profile: 'personal', topic_id: null, suggestions: [{}]})};
  const res = fakeRes();
  await handleShelf(req({action: 'sort', id}), res, {embedder, sorter, makeClient: () => db, verify});
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).suggestions, 1);
  assert.ok(calls.includes('record_document_turn'), 'the person’s words go on to memory');
  current = {...read, sorted_at: '2026-11-04T10:00:00Z'};
  const again = fakeRes();
  await handleShelf(req({action: 'sort', id}), again, {embedder, sorter, makeClient: () => db, verify});
  assert.equal(again.status, 409);
});
