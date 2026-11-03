import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {seal, open, googleBody, exchangeCode, authUrl, googleConfig, SCOPES} from '../server/google.mjs';
import {handleGoogle} from '../server/google-handler.mjs';

process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= 'test-publishable';
const key = randomBytes(32);
const config = {clientId: 'client', clientSecret: 'secret', sealKey: key};
const verify = async token => { if (token !== 'person') throw Error('bad'); return {sub: 'alice'}; };
const id = '50000000-0000-4000-8000-000000000001';
function fakeRes() {
  const res = {status: 0, headers: {}, body: ''};
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (status, headers = {}) => { res.status = status; Object.assign(res.headers, headers); };
  res.end = body => { res.body = body ?? ''; };
  return res;
}
const req = body => ({method: 'POST', headers: {authorization: 'Bearer person', host: 'satchel.test'}, body});
const json = (status, body) => ({ok: status < 400, status, json: async () => body});

test('a sealed token opens only with the same key, and a tampered one does not', () => {
  const sealed = seal('refresh-123', key);
  assert.equal(open(sealed, key), 'refresh-123');
  assert.notEqual(sealed.includes('refresh-123'), true);
  assert.throws(() => open(sealed, randomBytes(32)));
  const [iv, tag, body] = sealed.split('.');
  assert.throws(() => open([iv, tag, body.slice(0, -2) + 'AA'].join('.'), key));
});

test('the config needs all three settings and a 32-byte key', () => {
  assert.equal(googleConfig({GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b'}), null);
  assert.equal(googleConfig({GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', SATCHEL_GOOGLE_TOKEN_KEY: 'c2hvcnQ='}), null);
  assert.ok(googleConfig({GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', SATCHEL_GOOGLE_TOKEN_KEY: key.toString('base64')}));
});

test('the consent link asks for offline access and only the four scopes', () => {
  const url = new URL(authUrl({clientId: 'client', redirectUri: 'https://x/settings/google', state: 's'}));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.deepEqual(url.searchParams.get('scope').split(' '), SCOPES);
});

test('a to-do becomes a task with its time in the notes; an event is timed or all day', () => {
  const todo = googleBody({kind: 'todo', title: 'Call the dentist', due_date: null, starts_at: '2026-11-10T09:30:00Z', source: 'call at 3'}, {timezone: 'Asia/Kolkata'});
  assert.equal(todo.kind, 'task');
  assert.equal(todo.body.due, '2026-11-10T00:00:00.000Z');
  assert.match(todo.body.notes, /^At 15:00\. From your Satchel Shelf/);
  const timed = googleBody({kind: 'event', title: 'Sync', starts_at: '2026-11-05T10:30:00Z', ends_at: '2026-11-05T11:00:00Z', source: 'sync at 4'}, {timezone: 'Asia/Kolkata'});
  assert.equal(timed.body.start.dateTime, '2026-11-05T10:30:00Z');
  const allDay = googleBody({kind: 'event', title: 'Goa', due_date: '2026-12-31', starts_at: null, source: 'goa'});
  assert.deepEqual([allDay.body.start.date, allDay.body.end.date], ['2026-12-31', '2027-01-01']);
});

test('a link with a missing permission is refused', async () => {
  const idToken = `x.${Buffer.from(JSON.stringify({email: 'me@work.com'})).toString('base64url')}.y`;
  const fetchImpl = async () => json(200, {refresh_token: 'r', id_token: idToken, scope: 'openid email https://www.googleapis.com/auth/tasks'});
  await assert.rejects(exchangeCode({...config, code: 'c', redirectUri: 'r', fetchImpl}), e => e.reason === 'missing_scope');
  const all = async () => json(200, {refresh_token: 'r', id_token: idToken, scope: SCOPES.join(' ')});
  assert.equal((await exchangeCode({...config, code: 'c', redirectUri: 'r', fetchImpl: all})).email, 'me@work.com');
});

function fakeDb({suggestion, sealed}) {
  const calls = [];
  return {calls, rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'read_shelf_suggestion') return {data: suggestion ? [suggestion] : [], error: null};
    if (name === 'google_link_token') return {data: sealed ?? null, error: null};
    if (name === 'shelf_sort_context') return {data: {timezone: 'Asia/Kolkata'}, error: null};
    if (name === 'decide_shelf_suggestion') return {data: [{id: args.p_id, status: 'added'}], error: null};
    if (name === 'save_google_link') return {data: null, error: null};
    return {data: null, error: null};
  }};
}

test('add sends the suggestion to the profile’s Google account and records the link', async () => {
  const suggestion = {id, profile: null, kind: 'event', title: 'Sync', due_date: null, starts_at: '2026-11-05T10:30:00Z',
    ends_at: '2026-11-05T11:00:00Z', source: 'sync at 4', status: 'pending'};
  const db = fakeDb({suggestion, sealed: seal('refresh', key)});
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('oauth2')) return json(200, {access_token: 'access'});
    return json(200, {htmlLink: 'https://calendar.google.com/event?eid=1'});
  };
  const missing = fakeRes();
  await handleGoogle(req({action: 'add', id}), missing, {config, makeClient: () => db, verify, fetchImpl});
  assert.equal(missing.status, 400, 'no profile on the suggestion and none picked');
  const res = fakeRes();
  await handleGoogle(req({action: 'add', id, profile: 'work'}), res, {config, makeClient: () => db, verify, fetchImpl});
  assert.equal(res.status, 200);
  assert.ok(seen.some(u => u.includes('calendar/v3')));
  const decided = db.calls.find(c => c[0] === 'decide_shelf_suggestion')[1];
  assert.deepEqual([decided.p_profile, decided.p_google_link], ['work', 'https://calendar.google.com/event?eid=1']);
});

test('add without a linked account says to link one, and calls Google not at all', async () => {
  const db = fakeDb({suggestion: {id, profile: 'personal', kind: 'todo', title: 'x', source: 'x', status: 'pending'}});
  let called = false;
  const res = fakeRes();
  await handleGoogle(req({action: 'add', id}), res, {config, makeClient: () => db, verify, fetchImpl: async () => { called = true; }});
  assert.equal(res.status, 409);
  assert.equal(called, false);
});

test('link seals the refresh token before it is saved; no config is a 503', async () => {
  const idToken = `x.${Buffer.from(JSON.stringify({email: 'me@gmail.com'})).toString('base64url')}.y`;
  const db = fakeDb({});
  const fetchImpl = async () => json(200, {refresh_token: 'refresh-xyz', id_token: idToken, scope: SCOPES.join(' ')});
  const res = fakeRes();
  await handleGoogle(req({action: 'link', profile: 'personal', code: 'abc'}), res, {config, makeClient: () => db, verify, fetchImpl});
  assert.equal(res.status, 200);
  const saved = db.calls.find(c => c[0] === 'save_google_link')[1];
  assert.equal(saved.p_email, 'me@gmail.com');
  assert.doesNotMatch(saved.p_token_cipher, /refresh-xyz/);
  assert.equal(open(saved.p_token_cipher, key), 'refresh-xyz');
  const none = fakeRes();
  await handleGoogle(req({action: 'start', profile: 'work'}), none, {config: null, makeClient: () => db, verify});
  assert.equal(none.status, 503);
});
