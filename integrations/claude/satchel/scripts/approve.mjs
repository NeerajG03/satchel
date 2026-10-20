#!/usr/bin/env node
// Satchel's reads run without asking. Every write still asks.
//
// The agent pulls memory less than it should, and one reason is plain: each
// retrieve_memory call stopped the person with a permission prompt, so the
// cheap move was to not call it. A read only shows the agent what the person
// already gave this connection, so asking adds nothing a grant did not settle.
// A write changes what every later session sees, so it keeps the prompt.
//
// Claude only. Codex 0.153 rejects `permissionDecision: allow` from a
// PreToolUse hook, so there the person's own approval settings still decide.
//
// No network, no file, no credential. It reads the tool name off stdin and
// either says allow or says nothing, and saying nothing leaves the host's own
// permission flow exactly as it was.
import {readHookInput} from './workspace.mjs';

// The same server arrives under more than one name: inside the plugin it is
// mcp__plugin_satchel_satchel__, added by hand it is mcp__satchel__, and as a
// claude.ai connector it is mcp__claude_ai_Satchel__. A connector the host
// names by an id cannot be told apart from anyone else's server, so it is not
// matched and keeps its prompt.
const SERVER = /^mcp__(?:plugin_satchel_satchel|satchel|claude_ai_satchel)__([a-z_]+)$/i;

// The tools that change nothing. Kept in step with the readOnlyHint
// annotations in server/mcp-server.mjs; tests/plugin-hooks.test.mjs checks the two agree.
const READS = new Set(['retrieve_memory', 'read_memory', 'memory_index', 'list_topics']);

const event = await readHookInput();
const tool = SERVER.exec(String(event?.tool_name ?? ''))?.[1];
if (event?.hook_event_name === 'PreToolUse' && tool && READS.has(tool))
  process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse',
    permissionDecision: 'allow', permissionDecisionReason: 'Satchel reads run without asking. Writes still ask.'}}));
