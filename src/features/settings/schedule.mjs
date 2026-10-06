// The overnight schedule, as plain functions.
//
// Kept out of the page for two reasons. The rules here are the same ones the
// database enforces in private.schedule_problem, and a rule written twice is a
// rule that drifts, so the sentences are identical and a test holds them to it.
// And working out "next run" in someone else's time zone is the sort of thing
// that is wrong for two weeks a year, which is not worth finding out on a page.
//
// A schedule is {days, times, timezone}. Days are 0 to 6 with Sunday as 0,
// times are 'HH:MM' on the 24 hour clock, and the zone is an IANA name.

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];

const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What is wrong with a schedule, as a sentence, or null. Same wording as the database. */
export function scheduleProblem({ days, times, timezone }) {
  if (!Array.isArray(days) || days.length < 1 || days.some(day => !Number.isInteger(day) || day < 0 || day > 6))
    return 'Choose at least one day of the week.';
  if (!Array.isArray(times) || times.length < 1 || times.length > 2 || times.some(time => !TIME.test(time)))
    return 'Choose one time, or two at most.';
  if (times.length === 2) {
    const gap = Math.abs(minutes(times[0]) - minutes(times[1]));
    if (gap < 60 || 1440 - gap < 60) return 'Two passes need to be at least an hour apart.';
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { return 'That time zone is not recognised.'; }
  return null;
}

/** The database sends 02:00:00. The page and the clock input both want 02:00. */
export const hourMinute = time => String(time).slice(0, 5);

/** In order and without repeats, as the database stores it. */
export function tidy({ days, times, timezone }) {
  return {
    days: [...new Set(days)].sort((a, b) => a - b),
    times: [...new Set(times)].sort(),
    timezone,
  };
}

export const sameSchedule = (a, b) => {
  const x = tidy(a), y = tidy(b);
  return x.timezone === y.timezone && x.days.join() === y.days.join() && x.times.join() === y.times.join();
};

/** "Every day at 02:00", "Weekdays at 02:00 and 14:00", "Mon, Wed at 09:00". */
export function describeSchedule(schedule) {
  const { days, times } = tidy(schedule);
  const which = days.length === 7 ? 'Every day'
    : days.join() === WEEKDAYS.join() ? 'Weekdays'
    : days.join() === '0,6' ? 'Weekends'
    : days.map(day => DAY_NAMES[day]).join(', ');
  return `${which} at ${times.join(' and ')}`;
}

// Milliseconds the zone is ahead of UTC at an instant.
function offsetAt(ms, timezone) {
  const whole = Math.floor(ms / 1000) * 1000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(whole));
  const get = type => Number(parts.find(part => part.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - whole;
}

// The instant a wall clock reads this time in this zone. Two passes because the
// offset at the guess can differ from the offset at the answer across a change.
function instant(timezone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - offsetAt(guess, timezone);
  return guess - offsetAt(first, timezone);
}

/** The next time the schedule fires after `now`, as a Date, or null. */
export function nextRun({ days, times, timezone }, now = new Date()) {
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const get = type => Number(local.find(part => part.type === type).value);
  const [year, month, day] = [get('year'), get('month') - 1, get('day')];
  let best = null;
  for (let ahead = 0; ahead <= 8; ahead++) {
    const date = new Date(Date.UTC(year, month, day + ahead));
    if (!days.includes(date.getUTCDay())) continue;
    for (const time of times) {
      const at = instant(timezone, date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
        Number(time.slice(0, 2)), Number(time.slice(3, 5)));
      if (at > now.getTime() && (best === null || at < best)) best = at;
    }
    if (best !== null) break;
  }
  return best === null ? null : new Date(best);
}
