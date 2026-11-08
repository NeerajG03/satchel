import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {seal, open, taskBody, eventBody, exchangeCode, authUrl, googleConfig, fetchEvents, fetchTasks, weekLines, bindingFor, pkce, SCOPES} from '../server/google.mjs';

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
  const lines = weekLines([...await fetchEvents('access', {fetchImpl}), ...await fetchTasks('access', {fetchImpl})]);
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

test('a to-do becomes a task with its time in the notes; an event is timed or all day, and needs a day', () => {
  const todo = taskBody({kind: 'todo', title: 'Call the dentist', due_date: null, starts_at: '2026-11-10T09:30:00Z', source: 'call at 3'}, {timezone: 'Asia/Kolkata'});
  assert.equal(todo.due, '2026-11-10T00:00:00.000Z');
  assert.match(todo.notes, /^At 15:00\. From your Satchel Shelf/);
  const timed = eventBody({kind: 'event', title: 'Sync', starts_at: '2026-11-05T10:30:00Z', ends_at: '2026-11-05T11:00:00Z', source: 'sync at 4'}, {timezone: 'Asia/Kolkata'});
  assert.equal(timed.start.dateTime, '2026-11-05T10:30:00Z');
  const allDay = eventBody({kind: 'event', title: 'Goa', due_date: '2026-12-31', starts_at: null, source: 'goa'});
  assert.deepEqual([allDay.start.date, allDay.end.date], ['2026-12-31', '2027-01-01']);
  assert.throws(() => eventBody({kind: 'todo', title: 'Someday', due_date: null, starts_at: null, source: 'x'}), e => e.reason === 'no_day');
});

test('a link with a missing permission is refused', async () => {
  const idToken = `x.${Buffer.from(JSON.stringify({email: 'me@work.com'})).toString('base64url')}.y`;
  const fetchImpl = async () => json(200, {refresh_token: 'r', id_token: idToken, scope: 'openid email https://www.googleapis.com/auth/tasks'});
  await assert.rejects(exchangeCode({...config, code: 'c', redirectUri: 'r', fetchImpl}), e => e.reason === 'missing_scope');
  const all = async () => json(200, {refresh_token: 'r', id_token: idToken, scope: SCOPES.join(' ')});
  assert.equal((await exchangeCode({...config, code: 'c', redirectUri: 'r', fetchImpl: all})).email, 'me@work.com');
});
