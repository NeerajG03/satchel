// Actions that span two systems, Supabase Auth or Storage and our tables,
// cannot share a transaction. Each one is ordered so a failure in the middle
// leaves nothing the person did not ask for, or takes back what it did.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionRepository} from '../src/features/connections/repository.ts';

const request = {clientId: 'app-1', label: 'Claude Code', personal: true, allTopics: false, topicIds: [], canWrite: false};

function authDb({approveError = null, grantError = null} = {}) {
  const calls = [];
  return {calls, db: {
    rpc: (name, args) => ({abortSignal: async () => { calls.push(name); return {error: name === 'authorize_agent_v3' ? grantError : null}; }}),
    auth: {oauth: {
      approveAuthorization: async () => { calls.push('approve'); return approveError ? {data: null, error: approveError} : {data: {redirect_url: 'https://app/cb?code=1'}, error: null}; },
      revokeGrant: async ({clientId}) => { calls.push(`revokeGrant:${clientId}`); return {error: null}; },
    }},
  }};
}

test('consent: a failed approval writes no grant', async () => {
  const {db, calls} = authDb({approveError: {message: 'authorization expired'}});
  await assert.rejects(createConnectionRepository(db).approve('auth-1', request), {message: 'authorization expired'});
  assert.deepEqual(calls, ['approve']);
});

test('consent: a refused grant takes the approval back, so the app never gets a working code', async () => {
  const {db, calls} = authDb({grantError: {code: '23514', message: 'Invalid topic selection'}});
  await assert.rejects(createConnectionRepository(db).approve('auth-1', request), {message: 'Invalid topic selection'});
  assert.deepEqual(calls, ['approve', 'authorize_agent_v3', 'revokeGrant:app-1']);
});

test('consent: a failed undo is tried again before giving up', async () => {
  const {db, calls} = authDb({grantError: {message: 'Invalid topic selection'}});
  let failures = 2;
  const revoke = db.auth.oauth.revokeGrant;
  db.auth.oauth.revokeGrant = async args => { if (failures-- > 0) { calls.push('revokeGrant:failed'); return {error: {message: 'offline'}}; } return revoke(args); };
  await assert.rejects(createConnectionRepository(db).approve('auth-1', request), {message: 'Invalid topic selection'});
  assert.deepEqual(calls, ['approve', 'authorize_agent_v3', 'revokeGrant:failed', 'revokeGrant:failed', 'revokeGrant:app-1']);
});

test('consent: both succeed, and the redirect is handed back only then', async () => {
  const {db, calls} = authDb();
  assert.deepEqual(await createConnectionRepository(db).approve('auth-1', request), {redirectUrl: 'https://app/cb?code=1'});
  assert.deepEqual(calls, ['approve', 'authorize_agent_v3']);
});

const {enableOvernight} = await import('../src/features/settings/enableOvernight.ts');
const done = {clientId: 'overnight-1', refreshToken: 'r', schedule: {days: [1], times: ['03:00'], timezone: 'UTC'}};
function overnightStores({running = null, enableError = null, statuses = null}) {
  const revoked = [];
  const answers = statuses ?? [running, running];
  let asked = 0;
  return {revoked,
    overnight: {status: async () => { const answer = answers[Math.min(asked++, answers.length - 1)]; if (answer instanceof Error) throw answer; return answer; },
      enable: async () => { if (enableError) throw enableError; }},
    connections: {revoke: async ({client_id}) => { revoked.push(client_id); return {oauthCleanupFailed: false}; }}};
}

test('overnight: when storing the sign-in fails, the connection the consent made goes too', async () => {
  const s = overnightStores({enableError: new Error('vault refused')});
  await assert.rejects(enableOvernight(s.overnight, s.connections, done), /vault refused/);
  assert.deepEqual(s.revoked, ['overnight-1']);
});

test('overnight: a running pass on the same connection is not cut off by a failed retry', async () => {
  const s = overnightStores({running: {client_id: 'overnight-1'}, enableError: new Error('vault refused')});
  await assert.rejects(enableOvernight(s.overnight, s.connections, done), /vault refused/);
  assert.deepEqual(s.revoked, []);
});

test('overnight: a stored sign-in revokes nothing', async () => {
  const s = overnightStores({});
  await enableOvernight(s.overnight, s.connections, done);
  assert.deepEqual(s.revoked, []);
});

test('overnight: a store that landed but lost its answer is kept, and counts as on', async () => {
  const s = overnightStores({statuses: [null, {client_id: 'overnight-1'}], enableError: new Error('timed out')});
  await enableOvernight(s.overnight, s.connections, done);
  assert.deepEqual(s.revoked, []);
});

test('overnight: when the state cannot be read, nothing is revoked', async () => {
  for (const statuses of [[new Error('offline')], [null, new Error('offline')]]) {
    const s = overnightStores({statuses, enableError: new Error('timed out')});
    await assert.rejects(enableOvernight(s.overnight, s.connections, done), /timed out/);
    assert.deepEqual(s.revoked, []);
  }
});
