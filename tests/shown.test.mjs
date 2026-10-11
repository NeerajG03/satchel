import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, utimesSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

process.env.SATCHEL_HOME = mkdtempSync(join(tmpdir(), 'satchel-shown-'));
const {remember, recordShown, shownSoFar, startShown, CAP} = await import('../integrations/shared/shown.mjs');

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the list keeps the newest ids, once each, under the cap the server takes', () => {
  assert.deepEqual(remember([id(1), id(2)], [id(2), id(3)]), [id(1), id(2), id(3)]);
  const many = Array.from({length: CAP + 5}, (_, i) => id(i));
  assert.equal(remember([], many).length, CAP);
  assert.equal(remember([], many)[0], id(5), 'the oldest go first');
});

test('a session keeps what it was shown through a resume, and drops it on a compact or a clear', () => {
  recordShown('s1', [id(1), 'not an id']);
  recordShown('s1', [id(2)]);
  assert.deepEqual(shownSoFar('s1'), [id(1), id(2)]);
  startShown('s1', 'resume');
  assert.deepEqual(shownSoFar('s1'), [id(1), id(2)]);
  startShown('s1', 'compact');
  assert.deepEqual(shownSoFar('s1'), []);
  recordShown('s1', [id(3)]);
  startShown('s1', 'clear');
  assert.deepEqual(shownSoFar('s1'), []);
  assert.deepEqual(shownSoFar('never-seen'), []);
});

test('lists nobody touched in two days are removed at the next session start', () => {
  const dir = join(process.env.SATCHEL_HOME, 'shown');
  mkdirSync(dir, {recursive: true});
  const stale = join(dir, 'old.json');
  writeFileSync(stale, '[]');
  const then = (Date.now() - 3 * 86400e3) / 1000;
  utimesSync(stale, then, then);
  startShown('s2', 'startup');
  assert.equal(existsSync(stale), false);
});
