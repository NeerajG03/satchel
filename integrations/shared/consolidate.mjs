#!/usr/bin/env node
// Working out what the last few conversations meant, in the background.
//
// Capture at the end of a turn sees a five row window and is blind to
// everything already remembered, so the only thing it can decide is "insert or
// not". Consolidation reads a whole finished conversation against the memories
// that already exist and decides what the set should look like now: add,
// extend, replace, retire, affirm, or nothing at all.
//
// That takes a model call over a whole session, which is far too slow to sit
// inside a hook. So it does not. Stop spawns this detached, exactly the way
// session start spawns connect.mjs, and the hook returns immediately. Nobody
// is waiting for this and nothing breaks if it never finishes.
//
// It uses the credential the plugin already has. There was a version of this
// that ran from a six hourly job inside the database, which meant storing a
// second long-lived token server side and asking every new user to sign in
// twice. The job is still there for anyone who wants memory processed while
// they are away, but it is not how this works by default, because the thing
// already holding a working credential is the hook.
//
// Only sessions that have gone quiet are touched. The one you are typing in is
// not finished, and consolidating half a conversation would read a decision
// the user is still in the middle of changing their mind about.
import {call, readCredentials} from './auth.mjs';
import {attemptState, recordAttempt} from './background.mjs';

// Roughly twice an hour per machine. Every Stop would be a model call per
// turn, which is the cost this design exists to avoid.
export const EVERY_MS = 30 * 60 * 1000;
// A session is finished when nothing has been said in it for this long.
const IDLE_MINUTES = 30;
// Per run. A backlog drains over several runs rather than in one long one,
// because a detached process that runs for minutes is one nobody can see.
const LIMIT = 5;

/** Whether Stop should spawn a run right now. Read by the hook before it
 *  spawns, so a machine with no credential never starts a process at all. */
export function consolidateState(now = Date.now()) {
  if (!readCredentials()?.refresh_token) return 'disconnected';
  return attemptState('consolidate', EVERY_MS, now);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Nothing is written to stdout. This is detached, so there is no hook
  // listening and anything printed would land in the person's terminal with
  // no context at all. The attempt file is the record.
  try {
    if (!readCredentials()?.refresh_token) process.exit(0);
    const response = await call('/api/consolidate',
      {idle_minutes: IDLE_MINUTES, limit: LIMIT}, {timeout: 180000});
    recordAttempt('consolidate', process.pid, {
      ok: Boolean(response.ok),
      status: response.status ?? null,
      documents: response.data?.documents ?? 0,
    });
  } catch (error) {
    // Recorded rather than raised. A failure here costs nothing today: the
    // documents stay unread and the next run picks them up.
    recordAttempt('consolidate', process.pid, {ok: false, error: String(error?.message ?? error).slice(0, 200)});
  }
  process.exit(0);
}
