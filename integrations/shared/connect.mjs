#!/usr/bin/env node
// Connecting Satchel's hooks, on purpose or on their own.
//
// Run it yourself:            node connect.mjs
// The session-start hook:     node connect.mjs --background
//
// The background form is what makes this automatic. A hook cannot sit and wait
// for someone to click Allow, so session start spawns this detached, says so in
// one line, and gets out of the way. The session it was started from carries no
// memory; the next one does.
import {connect, readCredentials, satchelHome} from './auth.mjs';
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const background = process.argv.includes('--background');
const log = background ? () => {} : message => process.stderr.write(message + '\n');

// Asking once an hour at most. Without this, a machine that is offline or a
// person who closed the tab gets a browser window on every single session,
// which is the kind of thing that makes people uninstall a plugin.
//
// But the first version recorded the attempt and then never looked at whether
// it worked, so one window the person did not get to in time meant an hour of
// every new session printing a command at them instead of retrying. That is
// exactly the manual step this is supposed to remove. An attempt that did not
// finish is worth making again, just not on every single session, and an
// attempt still running is worth saying out loud rather than replacing.
const RETRY_AFTER_MS = 10 * 60 * 1000;
const attemptPath = () => join(satchelHome(), 'connect-attempt.json');

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Signal 0 checks for the process without touching it. EPERM is a yes: the
  // process exists and belongs to someone else. Treating every throw as "gone"
  // is the easy version of this and it is wrong.
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
};

/** One of four answers, because the person needs a different sentence for each.
 *
 *    connected  nothing to do
 *    waiting    a window is already open; say so instead of opening a second
 *    recent     we tried a moment ago and it did not finish; do not nag
 *    offer      open one
 */
export function connectState(now = Date.now()) {
  if (readCredentials()?.refresh_token) return 'connected';
  let last = null;
  try { last = JSON.parse(readFileSync(attemptPath(), 'utf8')); } catch { /* Never tried. */ }
  if (alive(last?.pid)) return 'waiting';
  if (last?.at && now - Number(last.at) < RETRY_AFTER_MS) return 'recent';
  return 'offer';
}

export function recordConnectAttempt(pid, now = Date.now()) {
  try {
    mkdirSync(satchelHome(), {recursive: true, mode: 0o700});
    writeFileSync(attemptPath(), JSON.stringify({at: now, pid}), {mode: 0o600});
  } catch { /* Then it asks again next time, which is the safe direction. */ }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (readCredentials()?.refresh_token && !process.argv.includes('--force')) {
      log('Satchel is already connected. Pass --force to connect again.');
      process.exit(0);
    }
    log('Opening your browser to connect Satchel.');
    await connect({log});
    log('Connected. Satchel memory will load on your next session.');
  } catch (error) {
    log(`Could not connect: ${error?.message ?? error}`);
    process.exit(background ? 0 : 1);
  }
}
