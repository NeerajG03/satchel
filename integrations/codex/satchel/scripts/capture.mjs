#!/usr/bin/env node
// The end of a turn.
//
// Sends the assistant's last message so the router can classify the turn that
// just ended. Nothing is injected from here: Claude can inject from Stop and
// Codex cannot, so a design that used it would work on one host only, and the
// next turn may change the subject anyway.
//
// It does not read the transcript. There was a version of this that did, on
// the belief that a command hook on UserPromptSubmit is not given the prompt
// and therefore could not record the user's side of the turn. That belief was
// wrong: the host passes `prompt` in the hook input, retrieve.mjs records the
// message when it arrives, and the host passes `last_assistant_message` here.
// Both halves of the turn reach the server without a file being opened, which
// is what Satchel always claimed and is true again.
import {call} from './auth.mjs';
import {repositoryFrom, commitsFrom, readHookInput, sessionIdOf, cwdOf, emit} from './workspace.mjs';

const event = await readHookInput();
const sessionKey = sessionIdOf(event);
if (!sessionKey || event.hook_event_name !== 'Stop') process.exit(0);

// Codex does not supply this, so on that host the router reads the user's
// messages without the replies. A stated degradation, not a bug to chase.
const assistant = typeof event.last_assistant_message === 'string'
  ? event.last_assistant_message.trim() : '';

const cwd = cwdOf(event);
const quiet = process.env.SATCHEL_DISABLE_REPOSITORY_STAGING === '1';
const repository = quiet ? null : repositoryFrom(cwd);

try {
  const response = await call('/api/hook-capture', {
    session_key: sessionKey,
    repository,
    // A count and nothing else, and only when there is a repository to count
    // in. It exists so a memory about how something is built can be doubted
    // when the code moved under it, which is the one kind of staleness no
    // conversation ever mentions.
    ...(repository ? {commits: commitsFrom(cwd)} : {}),
    assistant,
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
  emit({notice: response.data.notice ?? ''});
} catch (error) {
  // A turn that could not be sent is not lost: the user's message is already
  // in the window from retrieve.mjs and classified_at has not moved, so the
  // next Stop offers it again.
  emit({notice: 'Satchel could not save · ' + String(error?.message ?? error).slice(0, 120)});
}
