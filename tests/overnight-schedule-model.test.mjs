// The page's half of the schedule: the same rules as the database, and "next
// run" in a zone that is not the machine's.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {scheduleProblem, describeSchedule, nextRun, tidy, sameSchedule, EVERY_DAY, WEEKDAYS}
  from '../src/features/settings/schedule.mjs';

const ok = {days: EVERY_DAY, times: ['02:00'], timezone: 'UTC'};

test('the page refuses what the database refuses, in the same words', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261006090000_overnight_schedule.sql', import.meta.url), 'utf8');
  const cases = [
    [{...ok, days: []}, 'Choose at least one day of the week.'],
    [{...ok, days: [7]}, 'Choose at least one day of the week.'],
    [{...ok, times: []}, 'Choose one time, or two at most.'],
    [{...ok, times: ['01:00', '02:00', '03:00']}, 'Choose one time, or two at most.'],
    [{...ok, times: ['25:00']}, 'Choose one time, or two at most.'],
    [{...ok, times: ['02:00', '02:30']}, 'Two passes need to be at least an hour apart.'],
    [{...ok, times: ['23:30', '00:15']}, 'Two passes need to be at least an hour apart.'],
    [{...ok, timezone: 'Mars/Phobos'}, 'That time zone is not recognised.'],
  ];
  for (const [schedule, sentence] of cases) {
    assert.equal(scheduleProblem(schedule), sentence);
    assert.ok(sql.includes(`'${sentence}'`), `the database has to say "${sentence}" too`);
  }
  assert.equal(scheduleProblem({...ok, times: ['02:00', '03:00']}), null);
  assert.equal(scheduleProblem({...ok, times: ['23:00', '00:00']}), null);
  assert.equal(scheduleProblem(ok), null);
});

test('a schedule reads back as a sentence', () => {
  assert.equal(describeSchedule(ok), 'Every day at 02:00');
  assert.equal(describeSchedule({...ok, days: WEEKDAYS, times: ['14:00', '02:00']}), 'Weekdays at 02:00 and 14:00');
  assert.equal(describeSchedule({...ok, days: [6, 0]}), 'Weekends at 02:00');
  assert.equal(describeSchedule({...ok, days: [3, 1]}), 'Mon, Wed at 02:00');
});

test('tidy and sameSchedule ignore order and repeats', () => {
  assert.deepEqual(tidy({days: [3, 1, 1], times: ['14:00', '02:00'], timezone: 'UTC'}),
    {days: [1, 3], times: ['02:00', '14:00'], timezone: 'UTC'});
  assert.ok(sameSchedule({...ok, days: [2, 1]}, {...ok, days: [1, 2, 2]}));
  assert.ok(!sameSchedule(ok, {...ok, timezone: 'Asia/Kolkata'}));
});

test('next run is in the person\'s zone, on a chosen day, and after now', () => {
  // 2026-10-07 is a Wednesday. 01:00 UTC is 06:30 in Kolkata.
  const now = new Date('2026-10-07T01:00:00Z');
  assert.equal(nextRun(ok, now).toISOString(), '2026-10-07T02:00:00.000Z');
  assert.equal(nextRun({...ok, timezone: 'Asia/Kolkata'}, now).toISOString(), '2026-10-07T20:30:00.000Z',
    '02:00 Thursday in Kolkata, because 02:00 today has gone');
  assert.equal(nextRun({...ok, times: ['02:00', '14:00']}, new Date('2026-10-07T03:00:00Z')).toISOString(),
    '2026-10-07T14:00:00.000Z', 'the second time of the day is next');
  // Weekdays only, asked on a Friday night: Monday.
  assert.equal(nextRun({...ok, days: WEEKDAYS}, new Date('2026-10-09T05:00:00Z')).toISOString(),
    '2026-10-12T02:00:00.000Z');
  // Exactly on the slot is not "next".
  assert.equal(nextRun(ok, new Date('2026-10-07T02:00:00Z')).toISOString(), '2026-10-08T02:00:00.000Z');
  assert.equal(nextRun({...ok, days: [3]}, new Date('2026-10-07T02:00:00Z')).toISOString(), '2026-10-14T02:00:00.000Z');
});

test('next run survives a clock change', () => {
  // US clocks went back at 02:00 on 2026-11-01, so 09:00 is UTC-4 the day before and UTC-5 from that morning.
  const zone = 'America/New_York';
  assert.equal(nextRun({days: EVERY_DAY, times: ['09:00'], timezone: zone}, new Date('2026-10-31T12:00:00Z')).toISOString(),
    '2026-10-31T13:00:00.000Z', 'before: UTC-4');
  assert.equal(nextRun({days: EVERY_DAY, times: ['09:00'], timezone: zone}, new Date('2026-11-01T12:00:00Z')).toISOString(),
    '2026-11-01T14:00:00.000Z', 'after: UTC-5');
});
