// The overview at the top of the Activity page. These are the sums behind its
// four lights, so a light that says "quota used" means the last call really
// was refused for quota, and "ready" means the button really would read it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quotaDayStart, splitWaiting, modelHealth, memorySet, isQuota} from '../src/features/activity/overview.ts';

test('the quota day starts at midnight in California, summer and winter', () => {
  // 16:20 in India on 23 Sep is 03:50 Pacific daylight time: the reset was at 07:00 UTC.
  assert.equal(new Date(quotaDayStart(Date.parse('2026-09-23T10:50:00Z'))).toISOString(), '2026-09-23T07:00:00.000Z');
  // 11:30 in India is still the day before in California.
  assert.equal(new Date(quotaDayStart(Date.parse('2026-09-23T06:00:00Z'))).toISOString(), '2026-09-22T07:00:00.000Z');
  // In December the clocks have gone back, so it is 08:00 UTC.
  assert.equal(new Date(quotaDayStart(Date.parse('2026-12-10T05:00:00Z'))).toISOString(), '2026-12-09T08:00:00.000Z');
});

test('a session counts as ready once it has been quiet for 30 minutes', () => {
  const now = Date.parse('2026-09-23T10:00:00Z');
  const doc = (id, minutesAgo) => ({id, session_key: id, project_id: null, turns: 4, chars: 100,
    last_turn_at: new Date(now - minutesAgo * 60000).toISOString(), consolidated_through: null});
  const {ready, active} = splitWaiting([doc('a', 90), doc('b', 30), doc('c', 29), doc('d', 1)], now);
  assert.deepEqual(ready.map(d => d.id), ['a', 'b']);
  assert.deepEqual(active.map(d => d.id), ['c', 'd']);
});

test('a model is judged by its last call, and a spent quota is named as one', () => {
  const call = (model, at, error = null) => ({model, error, created_at: `2026-09-23T0${at}:00:00Z`, source: 'capture'});
  const health = modelHealth([
    call('gemini-3.8-flash', 1), call('gemini-3.8-flash', 2, 'the day\'s free quota is used up (20 requests)'),
    call('gemini-3.5-flash', 3),
    call('gemini-3.5-flash', 1, 'Gemini answered 503'),
    call('other', 0, 'Gemini answered 500'),
  ]);
  assert.deepEqual(health.map(h => [h.model, h.state, h.answered, h.failed]), [
    ['gemini-3.5-flash', 'answering', 1, 1],
    ['gemini-3.8-flash', 'quota', 1, 1],
    ['other', 'failing', 0, 1],
  ]);
  // A model that failed earlier and answered since is answering. The error is
  // still there to read, it just does not decide the light.
  assert.equal(health[0].lastError, 'Gemini answered 503');
  assert.equal(isQuota('consolidation is rate limited'), true);
  assert.equal(isQuota('Gemini answered 503'), false);
});

test('the memory set is counted by scope and by kind', () => {
  const slugs = new Map([['p1', 'satchel']]);
  const set = memorySet([
    {project_id: 'p1', band: 'heard', kind: 'fact'}, {project_id: 'p1', band: 'said', kind: 'preference'},
    {project_id: null, band: 'heard', kind: 'preference'}, {project_id: 'gone', band: 'said', kind: 'intent'},
  ], slugs);
  assert.equal(set.live, 4);
  assert.equal(set.heard, 2);
  assert.deepEqual(set.scopes, [['satchel', 2], ['personal', 1], ['a project', 1]]);
  assert.deepEqual(set.kinds, [['preference', 2], ['fact', 1], ['intent', 1]]);
});
