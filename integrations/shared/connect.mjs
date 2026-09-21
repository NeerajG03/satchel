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
const ATTEMPT_EVERY_MS = 60 * 60 * 1000;
const attemptPath = () => join(satchelHome(), 'last-connect-attempt');

export function shouldOfferConnect(now = Date.now()) {
  if (readCredentials()?.refresh_token) return false;
  try { if (now - Number(readFileSync(attemptPath(), 'utf8')) < ATTEMPT_EVERY_MS) return false; }
  catch { /* No record of an attempt is a reason to make one. */ }
  return true;
}

export function recordConnectAttempt(now = Date.now()) {
  try {
    mkdirSync(satchelHome(), {recursive: true, mode: 0o700});
    writeFileSync(attemptPath(), String(now), {mode: 0o600});
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
