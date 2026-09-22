// The attempt file, which is how a hook knows whether a detached child it
// started earlier is still going.
//
// This used to live inside connect.mjs and could only be tested by spawning
// the whole script. It is out here now because the logic is fiddly in a way
// that does not show up in a spawn test: a pid that belongs to someone else
// is alive, and an attempt that never finished has to be retried rather than
// remembered forever. Getting the second one wrong is the bug connect had,
// where one browser window nobody got to in time meant an hour of every new
// session printing a command by hand instead of trying again.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const home = () => mkdtempSync(join(tmpdir(), 'satchel-bg-'));
process.env.SATCHEL_HOME = home();
const {attemptState, recordAttempt, alive} = await import('../integrations/shared/background.mjs');

const attempt = (dir, value) => writeFileSync(join(dir, 'thing-attempt.json'), JSON.stringify(value));

test('never tried is due, just tried is not, and long enough ago is due again', () => {
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  const HOUR = 3600_000;
  try {
    assert.equal(attemptState('thing', HOUR), 'due');
    attempt(dir, {at: Date.now(), pid: -1});
    assert.equal(attemptState('thing', HOUR), 'recent');
    assert.equal(attemptState('thing', HOUR, Date.now() + HOUR + 1), 'due',
      'it comes back round, rather than being once per machine forever');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a child still running is left alone rather than raced', () => {
  // pid 1 is always alive. Two of the same job at once is the thing this
  // exists to prevent.
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try {
    attempt(dir, {at: Date.now() - 10 * 3600_000, pid: 1});
    assert.equal(attemptState('thing', 3600_000), 'running',
      'old enough to be due, but one is in flight');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a child that died mid-run does not block the next one forever', () => {
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try {
    attempt(dir, {at: Date.now() - 10 * 3600_000, pid: 999999});
    assert.equal(attemptState('thing', 3600_000), 'due');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a pid that belongs to someone else still counts as alive', () => {
  // process.kill throws EPERM for a process you do not own. Reading every
  // throw as "gone" is the easy version of this and it is wrong.
  assert.equal(alive(1), true);
  assert.equal(alive(0), false);
  assert.equal(alive(-1), false);
  assert.equal(alive(undefined), false);
  assert.equal(alive('1'), false);
});

test('what happened is written down, and two jobs do not share a file', () => {
  const dir = home();
  process.env.SATCHEL_HOME = dir;
  try {
    recordAttempt('connect', 4242, {ok: true});
    const written = JSON.parse(readFileSync(join(dir, 'connect-attempt.json'), 'utf8'));
    assert.equal(written.pid, 4242);
    assert.equal(written.ok, true);
    assert.equal(typeof written.at, 'number');
    assert.equal(attemptState('something-else', 1000), 'due',
      'one file per job, or connecting would suppress the other one');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
