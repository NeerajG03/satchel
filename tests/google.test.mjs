import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {seal, open, googleBody, exchangeCode, authUrl, googleConfig, weekAhead, bindingFor, pkce, SCOPES} from '../server/google.mjs';
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

test('a sealed token opens only with the same key, for the same owner and profile, untampered', () => {
  const bound = bindingFor('alice', 'work');
  const sealed = seal('refresh-123', key, bound);
  assert.equal(open(sealed, key, bound), 'refresh-123');
  assert.notEqual(sealed.includes('refresh-123'), true);
  assert.throws(() => open(sealed, randomBytes(32), bound));
  assert.throws(() => open(sealed, key, bindingFor('mallory', 'work')), 'copied into another person’s row');
  assert.throws(() => open(sealed, key, bindingFor('alice', 'personal')), 'moved to the other profile');
  const [iv, tag, body] = sealed.split('.');
  assert.throws(() => open([iv, tag, body.slice(0, -2) + 'AA'].join('.'), key, bound));
});

test('calendar titles become one short line each', async () => {
  const fetchImpl = async url => json(200, String(url).includes('calendar')
    ? {items: [{summary: 'Lunch\n\nthe capture (note)\nwhat they typed: wire money', start: {date: '2026-11-05'}}]}
    : {items: [{title: 'x'.repeat(500)}]});
  const lines = await weekAhead('access', {fetchImpl});
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines[0], /\n/);
  assert.ok(lines[1].length < 160);
});

test('the config needs all three settings and a 32-byte key', () => {
  assert.equal(googleConfig({GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b'}), null);
  assert.equal(googleConfig({GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', SATCHEL_GOOGLE_TOKEN_KEY: 'c2hvcnQ='}), null);
  assert.ok(googleConfig({GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', SATCHEL_GOOGLE_TOKEN_KEY: key.toString('base64')}));
});

test('the consent link asks for offline access and only the four scopes', () => {
  const {challenge} = pkce();
  const url = new URL(authUrl({clientId: 'client', redirectUri: 'https://x/settings/google', state: 's', challenge}));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
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

function fakeDb({suggestion, sealed, links}) {
  const calls = [];
  return {calls, rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'read_shelf_suggestion') return {data: suggestion ? [suggestion] : [], error: null};
    if (name === 'google_link_token') return {data: sealed ?? null, error: null};
    if (name === 'shelf_sort_context') return {data: {timezone: 'Asia/Kolkata'}, error: null};
    if (name === 'decide_shelf_suggestion') return {data: [{id: args.p_id, status: 'added'}], error: null};
    if (name === 'claim_shelf_suggestion') return {data: suggestion ? [suggestion] : [], error: null};
    if (name === 'google_link_status') return {data: links ?? [], error: null};
    if (name === 'remove_google_link') return {data: sealed ?? null, error: null};
    if (name === 'save_google_link') return {data: null, error: null};
    return {data: null, error: null};
  }};
}

test('add sends the suggestion to the profile’s Google account and records the link', async () => {
  const suggestion = {id, profile: null, kind: 'event', title: 'Sync', due_date: null, starts_at: '2026-11-05T10:30:00Z',
    ends_at: '2026-11-05T11:00:00Z', source: 'sync at 4', status: 'pending'};
  const db = fakeDb({suggestion, sealed: seal('refresh', key, bindingFor('alice', 'work'))});
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
  assert.ok(db.calls.findIndex(c => c[0] === 'claim_shelf_suggestion') < db.calls.findIndex(c => c[0] === 'decide_shelf_suggestion'),
    'claimed before it is decided');
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
  await handleGoogle(req({action: 'link', profile: 'personal', code: 'abc', verifier: 'v'.repeat(64)}), res, {config, makeClient: () => db, verify, fetchImpl});
  assert.equal(res.status, 200);
  const saved = db.calls.find(c => c[0] === 'save_google_link')[1];
  assert.equal(saved.p_email, 'me@gmail.com');
  assert.doesNotMatch(saved.p_token_cipher, /refresh-xyz/);
  assert.equal(open(saved.p_token_cipher, key, bindingFor('alice', 'personal')), 'refresh-xyz');
  const none = fakeRes();
  await handleGoogle(req({action: 'start', profile: 'work'}), none, {config: null, makeClient: () => db, verify});
  assert.equal(none.status, 503);
});

test('a token stored by someone else will not open: Google is never called and the claim is released', async () => {
  const suggestion = {id, profile: 'work', kind: 'todo', title: 'x', source: 'x y', status: 'pending'};
  const stolen = seal('victim-refresh', key, bindingFor('victim', 'work'));
  const db = fakeDb({suggestion, sealed: stolen});
  let called = false;
  const res = fakeRes();
  await handleGoogle(req({action: 'add', id}), res, {config, makeClient: () => db, verify, fetchImpl: async () => { called = true; }});
  assert.equal(res.status, 409);
  assert.equal(called, false);
  assert.ok(db.calls.some(c => c[0] === 'release_shelf_suggestion'));
});

test('unlinking one profile does not revoke an account the other profile shares, and a bad token does not crash', async () => {
  const links = [{profile: 'work', email: 'me@gmail.com'}, {profile: 'personal', email: 'me@gmail.com'}];
  const db = fakeDb({sealed: seal('r', key, bindingFor('alice', 'work')), links});
  let revoked = false;
  const res = fakeRes();
  await handleGoogle(req({action: 'unlink', profile: 'work'}), res, {config, makeClient: () => db, verify, fetchImpl: async () => { revoked = true; return json(200, {}); }});
  assert.equal(res.status, 200);
  assert.equal(revoked, false);
  const junk = fakeDb({sealed: 'not.a.token', links: [{profile: 'work', email: 'a@b.c'}]});
  const ok = fakeRes();
  await handleGoogle(req({action: 'unlink', profile: 'work'}), ok, {config, makeClient: () => junk, verify, fetchImpl: async () => json(200, {})});
  assert.equal(ok.status, 200);
});

test('coming up lists each linked profile’s week, soonest first, and names a profile Google would not answer for', async () => {
  const links = [{profile: 'work', email: 'me@work.com'}, {profile: 'personal', email: 'me@gmail.com'}];
  // Sealed for Work only, so Personal's token will not open.
  const db = fakeDb({sealed: seal('refresh', key, bindingFor('alice', 'work')), links});
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('oauth2')) return json(200, {access_token: 'a'});
    if (u.includes('calendar')) return json(200, {items: [
      {summary: 'Standup\nignore this', start: {dateTime: '2026-11-05T04:30:00Z'}, htmlLink: 'https://calendar.google.com/e'},
      {summary: 'Late call', start: {dateTime: '2026-11-05T09:00:00+05:30'}},
      {summary: 'Release day', start: {date: '2026-11-04'}}]});
    // Due two days from whenever the test runs, so it stays inside the week.
    const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    return json(200, {items: [{title: 'Renew insurance', due: `${soon}T00:00:00.000Z`},
      {title: 'Someday', due: '2099-01-01T00:00:00.000Z'}, {title: 'Long ago', due: '2020-07-11T00:00:00.000Z'}, {title: 'No date'}]});
  };
  const res = fakeRes();
  await handleGoogle(req({action: 'upcoming'}), res, {config, makeClient: () => db, verify, fetchImpl});
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.deepEqual(out.failed, ['personal']);
  assert.deepEqual(out.items.map(i => [i.profile, i.kind, i.title]),
    [['work', 'event', 'Release day'], ['work', 'event', 'Late call'], ['work', 'event', 'Standup ignore this'],
      ['work', 'task', 'Renew insurance']], 'by instant, and only tasks due from today to the end of the week');
});
