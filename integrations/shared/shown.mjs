// What this session has already been shown, so the next prompt does not show
// it again.
//
// The server cannot answer that itself: the injection log is the person's and
// a connection is not allowed to read it back. So the hook keeps the ids it was
// handed, one small file per session, and sends them as `exclude`.
//
// Only ids, never memory text. The list ends when the agent's context does:
// a new session, a clear, or a compact drops what was shown, and a memory may
// be shown again after that. A resume keeps it, because the transcript, and
// what was in it, comes back.
import {readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {satchelHome} from './auth.mjs';

/** The server takes at most this many. The oldest go first: they are the ones
 *  most likely to have left the agent's attention anyway. */
export const CAP = 50;

/** Session start sources after which nothing earlier is in front of the agent. */
export const RESETS = new Set(['startup', 'clear', 'compact']);

/** The list after a prompt showed `ids`. Pure, so the eval replays the same rule. */
export function remember(list = [], ids = []) {
  const next = list.filter(id => !ids.includes(id));
  next.push(...ids);
  return next.slice(-CAP);
}

const ID = /^[0-9a-f-]{36}$/i;
const dir = () => join(satchelHome(), 'shown');
const fileOf = sessionKey => join(dir(), `${sessionKey}.json`);

/** Never throws: a lost list only means a repeat, never a failed prompt. */
export function shownSoFar(sessionKey) {
  try {
    const list = JSON.parse(readFileSync(fileOf(sessionKey), 'utf8'));
    return Array.isArray(list) ? list.filter(id => typeof id === 'string' && ID.test(id)).slice(-CAP) : [];
  } catch { return []; }
}

export function recordShown(sessionKey, ids) {
  const clean = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && ID.test(id));
  if (!clean.length) return;
  try {
    mkdirSync(dir(), {recursive: true, mode: 0o700});
    writeFileSync(fileOf(sessionKey), JSON.stringify(remember(shownSoFar(sessionKey), clean)), {mode: 0o600});
  } catch { /* best effort */ }
}

// Whether this session was already told, once, that a miss is not the end of
// it. Same life as the list: a clear or a compact drops it, so the note comes
// back when the agent no longer has it in front of it.
const hintOf = sessionKey => join(dir(), `${sessionKey}.hint`);
export const hintSent = sessionKey => existsSync(hintOf(sessionKey));
export function recordHint(sessionKey) {
  try {
    mkdirSync(dir(), {recursive: true, mode: 0o700});
    writeFileSync(hintOf(sessionKey), '', {mode: 0o600});
  } catch { /* a lost marker only means the note comes once more */ }
}

/** `auto` when this package lets Satchel's reads run without a prompt, which
 *  is when the PreToolUse script ships beside this one. The server only says
 *  a read needs no approval when that is true. */
export const readsMode = () => existsSync(join(dirname(fileURLToPath(import.meta.url)), 'approve.mjs')) ? 'auto' : 'ask';

/** Called at session start. Clears this session's list when its context was
 *  dropped, and removes lists nobody has touched in two days. */
export function startShown(sessionKey, source) {
  try {
    if (RESETS.has(source)) { rmSync(fileOf(sessionKey), {force: true}); rmSync(hintOf(sessionKey), {force: true}); }
    const old = Date.now() - 2 * 86400e3;
    for (const name of readdirSync(dir())) {
      const path = join(dir(), name);
      if (statSync(path).mtimeMs < old) rmSync(path, {force: true});
    }
  } catch { /* nothing there yet */ }
}
