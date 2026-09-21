#!/usr/bin/env node
// Memory close to what you just said, on every prompt.
//
// This was briefly deleted, on the belief that a command hook is not handed
// the prompt text. It is. The host builds the hook input as
//
//   {…, hook_event_name: "UserPromptSubmit", prompt, session_title}
//
// so `prompt` arrives on stdin like everything else, and no transcript needs
// to be opened to find it. That one wrong belief also became the excuse for
// reading the transcript at Stop, which is why capture.mjs no longer does.
//
// Two jobs, and the first runs whether or not the second finds anything: the
// message is recorded server side, because the rolling window the router reads
// at the end of the turn is built from exactly this. Deleting retrieval once
// silently took capture with it for that reason.
import {call} from './auth.mjs';
import {repositoryFrom, readHookInput, sessionIdOf, cwdOf, emit} from './workspace.mjs';

const event = await readHookInput();
const sessionKey = sessionIdOf(event);
if (!sessionKey || event.hook_event_name !== 'UserPromptSubmit') process.exit(0);

// Codex documents this field as `prompt` and so does Claude's hook input. The
// other spelling is read as a fallback rather than assumed absent, because
// getting this wrong is a feature that silently searches for nothing.
const prompt = [event.prompt, event.user_prompt]
  .map(value => typeof value === 'string' ? value.trim() : '')
  .find(Boolean) ?? '';
if (!prompt) process.exit(0);

try {
  const response = await call('/api/hook-retrieve', {
    session_key: sessionKey,
    prompt,
    repository: process.env.SATCHEL_DISABLE_REPOSITORY_STAGING === '1' ? null : repositoryFrom(cwdOf(event)),
  }, {timeout: 4000});
  // Not connected is silent here. Session start already said so once, and
  // repeating it on every prompt is how a person learns to ignore the line
  // that matters.
  if (!response.connected) process.exit(0);
  if (!response.ok) {
    emit({notice: response.status === 401 || response.status === 403
      ? 'Satchel disconnected · no memory retrieved' : `Satchel unavailable · ${response.status}`});
    process.exit(0);
  }
  // Finding nothing is the common case and costs nothing: no block, no line.
  emit({event: 'UserPromptSubmit', context: response.data.context ?? '', notice: response.data.notice ?? ''});
} catch (error) {
  // A hook that delays or fails a prompt is worse than one that misses it, so
  // a timeout here is a quiet turn rather than an error the person has to read.
  emit({notice: 'Satchel unavailable · ' + String(error?.message ?? error).slice(0, 120)});
}
