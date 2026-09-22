// When the Stop hook decides to run the background pass.
//
// The pass is a model call over a whole conversation, so it cannot run inside
// a hook and it must not run on every turn. It is spawned detached, the way
// session start spawns connect.mjs, and the only thing standing between that
// and a model call per turn is this state machine. It is worth testing
// directly, because the failure is a cost rather than an error: everything
// keeps working, it is just billed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const home = () => mkdtempSync(join(tmpdir(), 'satchel-bg-'));
const connected = dir => writeFileSync(join(dir, 'credentials.json'),
  JSON.stringify({client_id: 'c', refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 1e6}));
const attempt = (dir, value) => writeFileSync(join(dir, 'consolidate-attempt.json'), JSON.stringify(value));

process.env.SATCHEL_HOME = home();
const {consolidateState, EVERY_MS} = await import('../integrations/shared/consolidate.mjs');
const {attemptState, recordAttempt, alive} = await import('../integrations/shared/background.mjs');

test('nothing is spawned on a machine that was never connected', () => {
  // Otherwise every Stop on a fresh install starts a process whose only job is
  // to find out it has no credential.
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try { assert.equal(consolidateState(), 'disconnected'); }
  finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the first turn after connecting is due, and the next half hour is not', () => {
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try {
    connected(dir);
    assert.equal(consolidateState(), 'due');

    // A run a moment ago. Every Stop would otherwise be a model call over a
    // whole session, which is the cost this whole design exists to avoid.
    attempt(dir, {at: Date.now(), pid: -1});
    assert.equal(consolidateState(), 'recent');

    assert.equal(consolidateState(Date.now() + EVERY_MS + 1), 'due',
      'and it comes back round, rather than being once per machine forever');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a run still going is left alone rather than raced', () => {
  // Two passes over the same documents would both read the same unread turns
  // and could both save the same claim. pid 1 is always alive.
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try {
    connected(dir);
    attempt(dir, {at: Date.now() - 10 * 60 * 60 * 1000, pid: 1});
    assert.equal(consolidateState(), 'running', 'old enough to be due, but one is in flight');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a process that died mid-run does not block the next one forever', () => {
  // The bug the connect flow had: an attempt was recorded and nobody ever
  // checked whether it finished, so one window nobody got to meant an hour of
  // being told to run a command by hand.
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try {
    connected(dir);
    attempt(dir, {at: Date.now() - 10 * 60 * 60 * 1000, pid: 999999});
    assert.equal(consolidateState(), 'due');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('what happened is written down, because nothing is watching a detached run', () => {
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try {
    recordAttempt('consolidate', 4242, {ok: true, status: 200, documents: 3});
    const written = JSON.parse(readFileSync(join(dir, 'consolidate-attempt.json'), 'utf8'));
    assert.equal(written.pid, 4242);
    assert.equal(written.documents, 3);
    assert.equal(written.ok, true);
    assert.equal(typeof written.at, 'number');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a pid that belongs to someone else still counts as alive', () => {
  // process.kill throws EPERM for a process you do not own. Reading every
  // throw as "gone" is the easy version of this and it is wrong.
  assert.equal(alive(1), true);
  assert.equal(alive(0), false);
  assert.equal(alive(-1), false);
  assert.equal(alive(undefined), false);
});

test('the two attempt files do not share a state', () => {
  // connect and consolidate both use this, with different intervals. One file
  // would mean connecting suppressed a pass and the other way round.
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try {
    recordAttempt('connect', 1);
    assert.equal(attemptState('consolidate', 1000), 'due');
    assert.equal(attemptState('connect', 1000), 'running');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
