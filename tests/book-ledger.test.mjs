// The book tells a new memory from a changed or re-said one using only its
// dates, so the rules that read them are tested on their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byDay, changeOf, dayOf, newestChange, newsByTopic, shortWhen } from '../src/features/memories/ledger.ts';

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



test('shortWhen fits a narrow column and uses the same seven days as the groups', () => {
  assert.equal(shortWhen(at(0, -20_000), now), '1 min');
  assert.equal(shortWhen(at(0, -59.8 * 60_000), now), '59 min');
  assert.equal(shortWhen(at(2), now), '2 h');
  const weekday = d => new Date(d).toLocaleDateString(undefined, { weekday: 'short' });
  assert.equal(shortWhen(at(24 * 6.5), now), weekday(at(24 * 6.5)), 'six and a half days back is still in the last seven');
  assert.doesNotMatch(shortWhen(at(24 * 20), now), /min| h$/);
});

test('a memory the overnight run made and then confirmed in the same pass is new, not said again', () => {
  // Added at 02:05, confirmed 159 seconds later because it was said twice.
  assert.equal(changeOf(evented('a', at(2), at(2, 159_000), at(2, 159_000), 'confirmed', at(2, 159_000))).why, 'new');
});

const topic = (row, topic_id) => ({ ...row, topic_id });

test('news is grouped by topic, busiest first, with what else moved counted', () => {
  const rows = [
    topic(memory('old', at(30)), null),
    topic(memory('mine', at(3)), null),
    topic(memory('a1', at(2)), 'api'), topic(memory('a2', at(4)), 'api'),
    topic(memory('again', at(300), at(300), at(1)), null),
    topic(evented('fixed', at(300), at(5), at(5), 'corrected', at(5)), 'api'),
  ];
  const ended = [{ topic_id: null, ended_at: at(6) }, { topic_id: null, ended_at: at(40) }];
  const news = newsByTopic(rows, ended, at(10), at(0));
  assert.deepEqual(news.map(n => n.topicId), ['api', null]);
  assert.deepEqual(news[0].fresh.map(m => m.id), ['a1', 'a2']);
  assert.deepEqual(news[0].changed.map(m => m.id), ['fixed']);
  assert.deepEqual(news[1].fresh.map(m => m.id), ['mine']);
  assert.deepEqual(news[1].again.map(m => m.id), ['again']);
  assert.equal(news[1].archived, 1, 'only what was archived inside the window');
});

test('a first visit has nothing to compare against, so there is no news', () => {
  assert.deepEqual(newsByTopic([memory('a', at(1))], [], null, at(0)), []);
});

test('what was written while the page was open is not news', () => {
  const news = newsByTopic([memory('before', at(3)), memory('mine', at(0, -1000))], [], at(10), at(1));
  assert.deepEqual(news[0].fresh.map(m => m.id), ['before']);
});

test('rows without their dates are not news, because they cannot tell new from edited', () => {
  assert.deepEqual(newsByTopic([{ id: 'x', statement: 'x', topic_id: null, updated_at: at(2) }], [], at(10), at(0)), []);
});

test('database times in either format compare by instant, not by text', () => {
  const pg = new Date(Date.parse(at(2))).toISOString().replace('Z', '+00:00');
  assert.equal(newsByTopic([memory('a', pg)], [], at(10), at(0))[0].fresh.length, 1);
});

test('the newest change bounds the visit, archive included, and an empty book starts at the beginning', () => {
  assert.equal(newestChange([memory('a', at(5)), memory('b', at(30), at(30), at(1))]), at(1));
  assert.equal(newestChange([memory('a', at(5))], [{ topic_id: null, ended_at: at(2) }]), at(2));
  assert.equal(newestChange([]), new Date(0).toISOString());
});
