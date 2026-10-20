// The book tells a new memory from a changed or re-said one using only its
// dates, so the rules that read them are tested on their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byDay, changeOf, dayOf, sinceLast } from '../src/features/memories/ledger.ts';

const now = new Date(2026, 9, 20, 15, 0).getTime();
const at = (hoursAgo, plusMs = 0) => new Date(now - hoursAgo * 3_600_000 + plusMs).toISOString();
const memory = (id, created, updated = created, affirmed = created) =>
  ({ id, statement: id, created_at: created, updated_at: updated, affirmed_at: affirmed });

test('a memory nobody touched since it was made is new', () => {
  assert.equal(changeOf(memory('a', at(2))).why, 'new');
});

test('a memory said again without new wording is said again, at the time it was said', () => {
  const change = changeOf(memory('a', at(50), at(50), at(1)));
  assert.equal(change.why, 'again');
  assert.equal(change.at, at(1));
});

test('a correction is changed', () => {
  assert.equal(changeOf(memory('a', at(50), at(1), at(1))).why, 'changed');
});

test('the two clocks of one statement do not read as two events', () => {
  // affirmed_at is now(), updated_at is clock_timestamp() a moment later.
  assert.equal(changeOf(memory('a', at(3), at(3, 40), at(3))).why, 'new');
  assert.equal(changeOf(memory('a', at(50), at(1, 40), at(1))).why, 'changed');
});

test('a row without the two dates falls back to updated_at and reads as new', () => {
  assert.deepEqual(changeOf({ id: 'a', updated_at: at(2) }), { at: at(2), why: 'new' });
});

test('days are calendar days, not 24 hour windows', () => {
  assert.equal(dayOf(at(14), now), 'today');
  assert.equal(dayOf(at(16), now), 'yesterday');
  assert.equal(dayOf(at(24 * 4), now), 'week');
  assert.equal(dayOf(at(24 * 9), now), 'older');
});

test('groups come newest first, skip empty days and count why each row moved', () => {
  const groups = byDay([
    memory('old', at(24 * 30)),
    memory('fresh', at(1)),
    memory('again', at(24 * 30), at(24 * 30), at(2)),
    memory('fixed', at(24 * 30), at(20), at(20)),
  ], now);
  assert.deepEqual(groups.map(g => g.day), ['today', 'yesterday', 'older']);
  assert.deepEqual(groups[0].items.map(m => m.id), ['fresh', 'again']);
  assert.deepEqual(groups[0].counts, { new: 1, again: 1, changed: 0 });
  assert.deepEqual(groups[1].counts, { new: 0, again: 0, changed: 1 });
});

test('since the last visit lists only new memories and counts the rest', () => {
  const rows = [memory('before', at(30)), memory('one', at(3)), memory('two', at(1)),
    memory('again', at(30), at(30), at(2))];
  const { fresh, moved } = sinceLast(rows, at(10), at(0));
  assert.deepEqual(fresh.map(m => m.id), ['two', 'one']);
  assert.equal(moved, 1);
});

test('a first visit has nothing to compare against, so it lists nothing', () => {
  assert.deepEqual(sinceLast([memory('a', at(1))], null), { fresh: [], moved: 0 });
});

test('what you wrote while the page was open is not news', () => {
  const rows = [memory('before', at(3)), memory('mine', at(0, -1000))];
  assert.deepEqual(sinceLast(rows, at(10), at(1)).fresh.map(m => m.id), ['before']);
});
