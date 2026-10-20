// The book tells a new memory from a changed or re-said one using only its
// dates, so the rules that read them are tested on their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byDay, changeOf, dayOf, newestChange, shortWhen, sinceLast } from '../src/features/memories/ledger.ts';

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
  assert.deepEqual(sinceLast([memory('a', at(1))], null, at(0)), { fresh: [], moved: 0 });
});

test('what you wrote while the page was open is not news', () => {
  const rows = [memory('before', at(3)), memory('mine', at(0, -1000))];
  assert.deepEqual(sinceLast(rows, at(10), at(1)).fresh.map(m => m.id), ['before']);
});

const evented = (id, created, updated, affirmed, last_change, last_change_at) =>
  ({ ...memory(id, created, updated, affirmed), last_change, last_change_at });

test('the last event names the change when there is one', () => {
  assert.equal(changeOf(evented('a', at(2), at(2, 40), at(2), 'added', at(2))).why, 'new');
  assert.equal(changeOf(evented('a', at(50), at(1, 40), at(1), 'corrected', at(1))).why, 'changed');
  assert.equal(changeOf(evented('a', at(50), at(1, 40), at(1), 'moved', at(1))).why, 'changed');
});

test('a first re-say of a picked-up memory is said again, not changed', () => {
  // The band flip writes a confirmed event and moves updated_at with it.
  assert.equal(changeOf(evented('a', at(50), at(1, 40), at(1), 'confirmed', at(1))).why, 'again');
});

test('being said again after the last event writes no event, and still reads as said again', () => {
  assert.equal(changeOf(evented('a', at(50), at(20), at(1), 'corrected', at(20))).why, 'again');
});

test('rows without their dates are not news, because they cannot tell new from edited', () => {
  const dateless = { id: 'x', statement: 'x', updated_at: at(2) };
  assert.deepEqual(sinceLast([dateless], at(10), at(0)), { fresh: [], moved: 0 });
});

test('the newest change is the visit bound, and an empty scope starts at the beginning', () => {
  assert.equal(newestChange([memory('a', at(5)), memory('b', at(30), at(30), at(1))]), at(1));
  assert.equal(newestChange([]), new Date(0).toISOString());
});

test('shortWhen fits a narrow column and uses the same seven days as the groups', () => {
  assert.equal(shortWhen(at(0, -20_000), now), '1 min');
  assert.equal(shortWhen(at(0, -59.8 * 60_000), now), '59 min');
  assert.equal(shortWhen(at(2), now), '2 h');
  const weekday = d => new Date(d).toLocaleDateString(undefined, { weekday: 'short' });
  assert.equal(shortWhen(at(24 * 6.5), now), weekday(at(24 * 6.5)), 'six and a half days back is still in the last seven');
  assert.doesNotMatch(shortWhen(at(24 * 20), now), /min| h$/);
});
