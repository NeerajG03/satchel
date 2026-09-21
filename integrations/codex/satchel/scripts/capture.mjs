#!/usr/bin/env node
// The end of a turn.
//
// Reads what the person and the assistant actually said since this script last
// ran, sends that, and prints one line if something was saved. Nothing is
// injected from here: Claude can inject from Stop and Codex cannot, so a design
// that used it would work on one host only, and the next turn may change the
// subject anyway.
//
// This is the one place Satchel reads the host's transcript file, and it is
// worth being plain about why, because the rest of this codebase says it never
// does.
//
// It never did, while capture was an mcp_tool hook: the host substituted
// ${prompt} and ${last_assistant_message} into the tool arguments and the
// server kept them in a 24 hour window. As a command script there is no
// substitution to receive. UserPromptSubmit does not hand a command hook the
// prompt at all, and the only documented way to reach it is this file.
//
// So the content that leaves the machine is the same content as before. What
// changed is where the script got it, and that a file it does not need all of
// is now open in front of it. That is what transcript.mjs is for: it takes the
// person's own messages and the assistant's plain text, and drops tool calls,
// tool results, thinking, subagent traffic, hook output, shell commands, slash
// commands and compaction summaries before any of it is sent.
import {call} from './auth.mjs';
import {readTranscriptDelta} from './transcript.mjs';
import {repositoryFrom, readHookInput, sessionIdOf, cwdOf, emit} from './workspace.mjs';
import {satchelHome} from './auth.mjs';
import {mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';

// Where this session got to last time, so a turn is sent once. The server has
// its own boundary as well, classified_at on each row, so losing this file
// costs a resent message and never a second copy of a memory.
const marksDir = () => join(satchelHome(), 'sessions');
const markPath = sessionKey => join(marksDir(), `${sessionKey}.json`);
const KEEP_MARKS_MS = 7 * 24 * 60 * 60 * 1000;

export function readMark(sessionKey) {
  try { return JSON.parse(readFileSync(markPath(sessionKey), 'utf8')).last ?? null; }
  catch { return null; }
}

export function writeMark(sessionKey, last) {
  try {
    mkdirSync(marksDir(), {recursive: true, mode: 0o700});
    writeFileSync(markPath(sessionKey), JSON.stringify({last, at: new Date().toISOString()}), {mode: 0o600});
    // One session is one file, so without this the directory grows forever.
    const cutoff = Date.now() - KEEP_MARKS_MS;
    for (const name of readdirSync(marksDir())) {
      const path = join(marksDir(), name);
      try { if (statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* Someone else's race. */ }
    }
  } catch { /* A lost mark resends a turn; the server deduplicates it. */ }
}

const event = await readHookInput();
const sessionKey = sessionIdOf(event);
if (!sessionKey || event.hook_event_name !== 'Stop') process.exit(0);

const transcript = typeof event.transcript_path === 'string' ? event.transcript_path : '';
if (!transcript) process.exit(0);

const {messages, last} = readTranscriptDelta(transcript, {after: readMark(sessionKey)});
// Nothing the person said means nothing to classify. Leaving early keeps the
// quiet turns free: no request, no token refresh, no model call.
if (!messages.some(m => m.role === 'user')) process.exit(0);

try {
  const response = await call('/api/hook-capture', {
    session_key: sessionKey,
    repository: process.env.SATCHEL_DISABLE_REPOSITORY_STAGING === '1' ? null : repositoryFrom(cwdOf(event)),
    // Role and content only. The uuid is the host's own identifier for a line
    // in its transcript; it is what the mark is kept by, locally, and it has no
    // business leaving the machine.
    messages: messages.map(({role, content}) => ({role, content})),
  }, {timeout: 20000});
  // Not connected is silent here. Session start already said so once, and
  // saying it again at the end of every turn is how a person learns to ignore
  // the line that matters.
  if (!response.connected) process.exit(0);
  if (!response.ok) {
    emit({notice: response.status === 401 || response.status === 403
      ? 'Satchel disconnected · nothing was saved' : `Satchel could not save · ${response.status}`});
    process.exit(0);
  }
  // Only on success. Moving the mark after a failed send would drop the turn
  // that failed, which is the one turn worth keeping.
  if (last) writeMark(sessionKey, last);
  emit({notice: response.data.notice ?? ''});
} catch (error) {
  // A turn that cannot be sent stays unmarked and is retried on the next Stop,
  // which is why the server's own boundary has to be the real one.
  emit({notice: 'Satchel could not save · ' + String(error?.message ?? error).slice(0, 120)});
}
