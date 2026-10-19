// Actions that span two systems, Supabase Auth or Storage and our tables,
// cannot share a transaction. Each one is ordered so a failure in the middle
// leaves nothing the person did not ask for, or takes back what it did.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionRepository} from '../src/features/connections/repository.ts';
import {removeOrphanedFiles} from '../scripts/task-files.mjs';

const request = {clientId: 'app-1', label: 'Claude Code', personal: true, allTopics: false, topicIds: [], canWrite: false,
  taskPersonal: false, taskAllTopics: false, taskTopicIds: [], taskCanWrite: false, taskCanUpload: false};

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

test('consent: both succeed, and the redirect is handed back only then', async () => {
  const {db, calls} = authDb();
  assert.deepEqual(await createConnectionRepository(db).approve('auth-1', request), {redirectUrl: 'https://app/cb?code=1'});
  assert.deepEqual(calls, ['approve', 'authorize_agent_v3']);
});

function storageDb({objects, rows}) {
  const removed = [];
  const now = Date.parse('2026-10-19T12:00:00Z');
  const old = '2026-10-19T09:00:00Z', fresh = '2026-10-19T11:59:00Z';
  const children = prefix => {
    const depth = prefix ? prefix.split('/').length : 0;
    const names = new Map();
    for (const [key, created] of Object.entries(objects)) {
      const parts = key.split('/');
      if (prefix && !key.startsWith(prefix + '/')) continue;
      const name = parts[depth];
      names.set(name, depth === 2 ? {id: key, name, created_at: created === 'fresh' ? fresh : old} : {id: null, name});
    }
    return [...names.values()];
  };
  return {removed, now, db: {
    storage: {from: () => ({
      list: async (prefix, {offset}) => ({data: children(prefix).slice(offset, offset + 1000), error: null}),
      remove: async keys => { removed.push(...keys); return {error: null}; },
    })},
    from: () => ({select: () => ({in: async (_, keys) => ({data: rows.filter(key => keys.includes(key)).map(object_key => ({object_key})), error: null})})}),
  }};
}

test('cleanup: files of a deleted account, which no row points at, are removed', async () => {
  const gone = 'gone-user', kept = 'live-user';
  const {db, removed, now} = storageDb({
    objects: {[`${gone}/t1/r1`]: 'old', [`${gone}/t1/r2`]: 'old', [`${kept}/t2/r3`]: 'old', [`${kept}/t2/r4`]: 'fresh'},
    rows: [`${kept}/t2/r3`],
  });
  assert.equal(await removeOrphanedFiles(db, {now}), 2);
  assert.deepEqual(removed.sort(), [`${gone}/t1/r1`, `${gone}/t1/r2`]);
});

test('cleanup: a file younger than the margin is left alone even without a row', async () => {
  const {db, removed, now} = storageDb({objects: {'u/t/r': 'fresh'}, rows: []});
  assert.equal(await removeOrphanedFiles(db, {now}), 0);
  assert.deepEqual(removed, []);
});

const {enableOvernight} = await import('../src/features/settings/enableOvernight.ts');
const done = {clientId: 'overnight-1', refreshToken: 'r', schedule: {days: [1], times: ['03:00'], timezone: 'UTC'}};
function overnightStores({running = null, enableError = null}) {
  const revoked = [];
  return {revoked,
    overnight: {status: async () => running, enable: async () => { if (enableError) throw enableError; }},
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
