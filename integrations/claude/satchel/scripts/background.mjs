// Running something detached, at most once in a while.
//
// Two hooks need the same small state machine and it is fiddly enough that two
// copies would drift. A detached child outlives the hook that started it, so
// the only way the next hook can tell "still going" from "tried and gave up"
// is a file with a pid in it.
//
// The first version of this recorded the attempt and never looked at whether
// it worked, so one window nobody got to in time meant an hour of every new
// session printing a command instead of retrying. An attempt that did not
// finish is worth making again, just not on every single event.
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {satchelHome} from './auth.mjs';

export const attemptPath = name => join(satchelHome(), `${name}-attempt.json`);

/** Signal 0 checks for the process without touching it. EPERM is a yes: it
 *  exists and belongs to someone else. Treating every throw as "gone" is the
 *  easy version of this and it is wrong. */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function readAttempt(name) {
  try { return JSON.parse(readFileSync(attemptPath(name), 'utf8')); }
  catch { return null; }
}

/** One of three, because the caller needs a different answer for each:
 *  a run is happening now, one happened recently, or it is due. */
export function attemptState(name, retryAfterMs, now = Date.now()) {
  const last = readAttempt(name);
  if (alive(last?.pid)) return 'running';
  if (last?.at && now - Number(last.at) < retryAfterMs) return 'recent';
  return 'due';
}

export function recordAttempt(name, pid, extra = {}, now = Date.now()) {
  try {
    mkdirSync(satchelHome(), {recursive: true, mode: 0o700});
    writeFileSync(attemptPath(name), JSON.stringify({at: now, pid, ...extra}), {mode: 0o600});
  } catch { /* Then it tries again next time, which is the safe direction. */ }
}
