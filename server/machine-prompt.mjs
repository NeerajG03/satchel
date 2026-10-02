// Which prompts a person typed, and which the host or another agent did.
//
// The per-prompt hook fires on every UserPromptSubmit, and the host sends it
// more than what the person types: a subagent's final report, a task
// notification, a CI monitor event, a slash command's expansion. Measured over
// the last week of real traffic, 57% of prompt-time memory hits and 59% of the
// injected slots went to these, every subagent hand-back scored a hit, and the
// three memories that took half of all slots only match that kind of text.
//
// Two things go wrong when they are treated as the person's words. Retrieval
// spends its slots on text nobody wrote, so the block the person sees is
// noise. And the turn is recorded as the user's half of the document, where
// the consolidation pass may quote it as a source, which is exactly the
// fabrication the source check exists to stop: a subagent's conclusion stored
// as something the person said.
//
// Kept as plain prefixes and tags rather than a model call, because this runs
// inside a hook budget on every prompt and the markers are the host's own.
const MARKERS = [
  ['<task-notification>', 'task notification'],
  ['[SYSTEM NOTIFICATION', 'system notification'],
  ['<agent-message', 'agent message'],
  ['Another Claude session sent a message', 'agent message'],
  ['[Subagent hand-back]', 'agent message'],
  ['<ci-monitor-event>', 'ci event'],
  ['<local-command-stdout>', 'command output'],
  ['<local-command-caveat>', 'command output'],
];

// A reminder block wraps nothing and is prepended to whatever the person
// typed: the week this shipped, all five prompts that began with one carried
// a real message after it. So the blocks are cut out and the rest is judged
// on its own; only a prompt that is nothing but reminders is the host's.
const REMINDER = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/g;
const COMMAND = /^\s*<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** Where this prompt came from, and what is worth searching for in it.
 *
 *  Returns `{kind, query}`. `kind` is null for a prompt the person typed. For a
 *  slash command the arguments are the person's words, so they become the
 *  query and the command wrapper is dropped; a command with no arguments is a
 *  machine message like the rest. `query` is null when nothing in the prompt
 *  is the person's. */
export function classifyPrompt(prompt) {
  const text = String(prompt ?? '').replace(REMINDER, '').trim();
  if (!text) return {kind: 'system reminder', query: null};
  const head = text.slice(0, 400);
  const command = head.match(COMMAND);
  if (command) {
    const args = text.match(COMMAND_ARGS)?.[1]?.trim() ?? '';
    return args ? {kind: null, query: args} : {kind: 'command', query: null};
  }
  for (const [marker, kind] of MARKERS)
    if (head.includes(marker)) return {kind, query: null};
  return {kind: null, query: text};
}

/** What the document records in place of a machine message. Short, and
 *  nothing in it can be mistaken for the person's words or quoted as a source. */
export const machineTurnNote = kind => `[host message, not the person: ${kind}]`;
