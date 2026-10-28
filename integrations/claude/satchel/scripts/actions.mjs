#!/usr/bin/env node
// After a tool runs: one line about it, written to a file on this machine.
//
// No network call, so it costs the agent nothing and works offline. capture.mjs
// sends the lines at the end of the turn. What a line may hold, and what it
// never may, is in actions-buffer.mjs.
import {readHookInput, sessionIdOf} from './workspace.mjs';
import {summarize, recordAction} from './actions-buffer.mjs';

try {
  const event = await readHookInput();
  const sessionKey = sessionIdOf(event);
  // The same switch that stops the repository being read: someone who turned
  // it off asked for less of their work to leave the machine, and commands
  // are more of it.
  if (sessionKey && event.hook_event_name === 'PostToolUse' && process.env.SATCHEL_DISABLE_REPOSITORY_STAGING !== '1')
    recordAction(sessionKey, summarize(event));
} catch { /* a hook that throws must never fail the agent's turn */ }
process.exit(0);
