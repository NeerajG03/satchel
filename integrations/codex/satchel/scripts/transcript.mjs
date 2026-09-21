// The last turn, out of the host's transcript file, and nothing else.
//
// This file exists because of one fact about command hooks: UserPromptSubmit
// does not receive the prompt text. Only `transcript_path` is offered, and the
// docs warn that the file "is written asynchronously and may lag the in-memory
// conversation". That warning is about reading it mid-turn.
//
// At Stop the turn is over. The user's message was written when the turn began
// and the assistant's replies are complete, so there is nothing to race. That
// is the entire reason capture reads the file here and never earlier.
//
// What this is allowed to take is deliberately small:
//
//   in   the user's own typed messages, and the assistant's plain text
//   out  tool calls, tool results, thinking, subagent traffic, hook output,
//        slash commands, shell input, compaction summaries, system reminders
//
// Everything in that second list is either not something the user said or not
// something anyone consented to send. The router only ever needed the first.

import {openSync, fstatSync, readSync, closeSync} from 'node:fs';

/** How much of the tail to look at. A turn is kilobytes; this is three orders
 *  of magnitude of headroom, and it keeps a long session from being read into
 *  memory in full on every single Stop. */
const TAIL_BYTES = 2 * 1024 * 1024;
/** Per message, and then overall. The router prompt is the real budget, and a
 *  pasted file should not push the turn out of it. */
const MAX_MESSAGE_CHARS = 8000;
const MAX_MESSAGES = 40;

// A user line whose text begins with one of these is the host talking, not the
// person. They arrive as ordinary `type:"user"` entries with string content and
// no flag that separates them, so the tag is the only signal there is.
const HOST_TAGS = new Set(['command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat',
  'bash-input', 'bash-stdout', 'bash-stderr', 'task-notification',
  'system-reminder', 'user-prompt-submit-hook', 'artifact-content-authored-by-others',
  'ide_selection', 'ide_opened_file', 'ide_diagnostics']);

const firstTag = text => text.startsWith('<') ? text.slice(1).match(/^[a-zA-Z0-9_-]+/)?.[0] ?? '' : '';

/** Blocks the host injects into an otherwise real message. The person did not
 *  type these and did not ask for them to be sent anywhere. */
const stripInjected = text => text
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
  .trim();

const clamp = text => text.length > MAX_MESSAGE_CHARS
  ? text.slice(0, MAX_MESSAGE_CHARS) + '\n[truncated]' : text;

/** One entry, reduced to what capture may see, or null when it may see none of
 *  it. Null is the common answer: most of a transcript is tool traffic. */
export function messageFrom(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // Subagents are their own conversation and the person never saw them.
  // isMeta is host-generated. A compaction summary is our own earlier output
  // coming back around, and treating it as something the user said is how a
  // summary of a memory becomes a second memory.
  if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) return null;
  if (typeof entry.uuid !== 'string') return null;
  if (entry.type === 'user') {
    // A tool result is also `type:"user"`. It carries toolUseResult and its
    // content is an array rather than a string, so either test alone is
    // enough; both are checked because a missed one sends tool output to a
    // server, and that is not a mistake worth risking for one comparison.
    if (entry.toolUseResult !== undefined) return null;
    const content = entry.message?.content;
    if (typeof content !== 'string') return null;
    const text = content.trim();
    if (HOST_TAGS.has(firstTag(text))) return null;
    const cleaned = stripInjected(text);
    return cleaned ? {uuid: entry.uuid, role: 'user', content: clamp(cleaned)} : null;
  }
  if (entry.type === 'assistant') {
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) return null;
    // text only. Thinking is not addressed to the user, and a tool_use block is
    // a file path or a command, which is exactly the kind of thing that must
    // not leave the machine.
    const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n').trim();
    return text ? {uuid: entry.uuid, role: 'assistant', content: clamp(text)} : null;
  }
  return null;
}

/** The tail of a file as whole lines. A partial first line is dropped rather
 *  than repaired: it is one message at the far end of a 2MB window, and
 *  guessing at half a JSON object is worse than losing it. */
function tailLines(path, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return {lines: (length < size ? text.slice(text.indexOf('\n') + 1) : text).split('\n')};
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Everything the person and the assistant said after `after`, in order.
 *
 *  `after` is the uuid of the last entry a previous capture already handled.
 *  When it is not in the window the fallback is the last few messages rather
 *  than the whole file, because "we lost our place" must not mean "send
 *  everything".
 *
 *  The server has its own boundary as well: rows carry classified_at and a
 *  turn is what has not been classified. So this being wrong costs a repeated
 *  message, not a repeated memory. */
export function readTranscriptDelta(path, {after = null, bytes = TAIL_BYTES, max = MAX_MESSAGES} = {}) {
  let lines;
  try { ({lines} = tailLines(path, bytes)); }
  catch { return {messages: [], last: null, found: false, lost: false}; }
  // Collected with their positions first, because "everything after the mark"
  // cannot be decided while still scanning: the mark may not be in the window
  // at all, and that case has to fall back rather than return nothing.
  const entries = [];
  let last = null;
  let mark = -1;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.uuid !== 'string') continue;
    last = entry.uuid;
    if (after && entry.uuid === after) mark = entries.length;
    entries.push(messageFrom(entry));
  }
  const found = !after || mark >= 0;
  // Losing the mark means the tail, never the whole file. The server's own
  // classified_at boundary is what stops a resent message becoming a second
  // memory, so the cost of this fallback is bounded on the other side too.
  const messages = (mark >= 0 ? entries.slice(mark + 1) : entries).filter(Boolean);
  return {messages: messages.slice(-max), last, found, lost: Boolean(after) && mark < 0};
}
