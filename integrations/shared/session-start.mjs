#!/usr/bin/env node
// Memory, at the moment a session opens.
//
// This replaces bootstrap.mjs, which could only stage a repository name and
// then ask the agent to go and fetch its own memory with a tool call. It had to
// ask, because the authenticated half was an mcp_tool hook and an mcp_tool hook
// does not run at launch: the host skips it with "no mcp_tool hooks are not
// available for the 'SessionStart' hook event (no MCP client context)". So the
// one event that most needed memory was the one event that never got it, and
// what arrived instead was an instruction the model could ignore.
//
// This script holds its own OAuth credential, so it fetches the index itself.
// Launch, clear, compact and resume all work the same way now, and none of them
// depend on the model deciding to make a call.
//
// What it sends: the session id, why it fired, and the workspace's normalized
// GitHub origin. Not the prompt, not the transcript, not a file, not a path,
// and never the host's own credentials.
import {call} from './auth.mjs';
import {repositoryFrom, readHookInput, sessionIdOf, cwdOf, emit} from './workspace.mjs';
import {connectState, recordConnectAttempt} from './connect.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// Said on every branch, because the guardrails do not depend on which branch
// was taken.
const RULES = ' Read relevant more info with read_memory; only names and descriptions belong in the automatic index.'
  + ' Never read host credentials or write memory automatically.';

/** The browser flow, detached, so the hook can return now. A session cannot
 *  wait for someone to click Allow, and holding it open until they do would
 *  make the first session after install feel broken. */
function offerConnect() {
  try {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'connect.mjs');
    const child = spawn(process.execPath, [script, '--background'], {stdio: 'ignore', detached: true});
    child.unref();
    // The pid, so the next session can tell "a window is open right now" from
    // "we tried and it did not finish". Recorded after the spawn, because a
    // spawn that threw is not an attempt.
    recordConnectAttempt(child.pid);
    return true;
  } catch { return false; }
}

/** What to say when there is no credential. Not an error: this is a Satchel
 *  that has not been set up yet, and it must not read like a broken one. */
function notConnected() {
  const state = connectState();
  if (state === 'waiting') return {
    context: 'Satchel is installed but not connected. A browser window is already open and waiting for you to allow it.',
    notice: 'Satchel not connected · finish in the browser window already open'};
  if (state === 'offer' && offerConnect()) return {
    context: 'Satchel is installed but not connected, so no memory has been loaded. A browser window was opened to connect it.',
    notice: 'Satchel not connected · opening your browser'};
  // Either a window was offered a few minutes ago and did not finish, or the
  // spawn failed. Both are rare, and both leave the person something to do.
  return {
    context: 'Satchel is installed but not connected, so no memory has been loaded. Run: node '
      + join(dirname(fileURLToPath(import.meta.url)), 'connect.mjs'),
    notice: 'Satchel not connected · run satchel connect'};
}

const event = await readHookInput();
const sessionKey = sessionIdOf(event);
// Both hosts handle compaction through SessionStart's compact source: Codex
// cannot emit additionalContext from PostCompact at all.
if (!sessionKey || (event.hook_event_name !== 'SessionStart' && event.hook_event_name !== 'PostCompact'))
  process.exit(0);

const hookEvent = event.hook_event_name;
const repository = process.env.SATCHEL_DISABLE_REPOSITORY_STAGING === '1'
  ? null : repositoryFrom(cwdOf(event));

try {
  const response = await call('/api/hook-index',
    {session_key: sessionKey, event: hookEvent, repository}, {timeout: 6000});

  if (!response.connected) {
    const {context, notice} = notConnected();
    emit({event: hookEvent, context: context + ' Do not claim memory loaded and do not invent any.', notice});
    process.exit(0);
  }
  if (!response.ok) {
    // 401 means the grant is gone. Anything else is Satchel being down. The
    // person is told which, because "reconnect" and "wait" are different jobs.
    const gone = response.status === 401 || response.status === 403;
    emit({event: hookEvent,
      context: `Satchel memory was not loaded (${gone ? 'this connection was revoked' : 'the service did not answer'}).`
        + ' Say so if memory matters here, and do not invent any.',
      notice: gone ? 'Satchel disconnected · reconnect in Apps' : `Satchel unavailable · ${response.status}`});
    process.exit(0);
  }
  // The server decides the exact bytes. This script never composes memory text
  // and never formats a memory: everything that could become an instruction is
  // shaped by our own formatter, server side.
  emit({event: hookEvent, context: (response.data.context ?? '') + RULES, notice: response.data.notice ?? ''});
} catch (error) {
  // A hook that throws must not take the session with it.
  emit({event: hookEvent,
    context: 'Satchel memory was not loaded because it could not be reached. Do not claim memory loaded.',
    notice: 'Satchel unavailable · ' + String(error?.message ?? error).slice(0, 120)});
}
