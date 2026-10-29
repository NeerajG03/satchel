// What the agent did this turn, kept on this machine until the turn ends.
//
// Consolidation reads the conversation, and a conversation holds the words but
// not the work: "fixed" in a reply does not say a file was edited, a commit made
// or a push run. So the PostToolUse hook leaves one short line per tool call
// here, and the Stop hook sends the lot with the reply and empties it.
//
// A line says what was done and to what, never what was in it. No file
// contents, no edit text, no tool output. Commands are kept because they are
// the clearest record of a commit or a push, and are scrubbed first, because
// people paste tokens into them. The server scrubs again; this is so a secret
// does not sit in a file on disk between the two.
import {readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {satchelHome} from './auth.mjs';

/** Lines kept per turn. The newest win: a commit or a push comes last. */
export const MAX_LINES = 60;
/** Characters per line, after the label. */
export const MAX_LINE = 200;

const dir = () => join(satchelHome(), 'actions');
const fileOf = sessionKey => join(dir(), `${sessionKey}.log`);

// Shapes that are secrets on sight, then the assignments and headers that carry
// one by name. Deliberately blunt: a command that loses a word too many is
// still a good record, and one that keeps a token is not.
const SECRETS = [
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[hidden]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '[hidden]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[hidden]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[hidden]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[hidden]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]'],
  [/(:\/\/[^\s/:@]*:)[^\s/@]+@/g, '$1[hidden]@'],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1$2[hidden]'],
  [/(--?(?:token|password|passwd|secret|api-key|apikey|auth)[= ])(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[hidden]'],
  [/(-H\s+["']?(?:authorization|x-api-key|apikey)\s*:\s*)[^"'\n]+/gi, '$1[hidden]'],
];

export function scrubCommand(text) {
  let out = String(text);
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out;
}

const SATCHEL_TOOLS = /^mcp__(plugin_satchel_satchel|satchel|claude_ai_[Ss]atchel)__/;
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = value => value.length > MAX_LINE ? value.slice(0, MAX_LINE - 1) + '…' : value;
const str = value => typeof value === 'string' ? value : '';
const joined = (...values) => values.map(v => oneLine(str(v))).filter(Boolean).join(' in ');

/** One line for a tool call, or null when it is not worth a line. Reads only
 *  the fields named below, so nothing else in the input can reach the file. */
export function summarize(event) {
  const name = typeof event?.tool_name === 'string' ? event.tool_name : '';
  if (!name || SATCHEL_TOOLS.test(name)) return null;
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  let label, what;
  if (name === 'Bash') [label, what] = ['ran', oneLine(str(input.command))];
  else if (['Edit', 'Write', 'MultiEdit'].includes(name)) [label, what] = ['edited', oneLine(str(input.file_path))];
  else if (name === 'NotebookEdit') [label, what] = ['edited', oneLine(str(input.notebook_path))];
  else if (name === 'Read') [label, what] = ['read', oneLine(str(input.file_path))];
  else if (name === 'Grep' || name === 'Glob') [label, what] = ['searched', joined(input.pattern, input.path)];
  // Any other tool, MCP ones included, by name alone. Its input may be a
  // message, a document or a query, and none of that is ours to keep.
  else [label, what] = ['used', oneLine(name)];
  // Scrubbed whatever it is: a search for a key is still a key.
  return what ? `${label}: ${clip(scrubCommand(what))}` : null;
}

/** Never throws: a lost line only means the record is a little shorter. */
export function recordAction(sessionKey, line) {
  if (!line) return;
  try {
    const path = fileOf(sessionKey);
    if (!existsSync(path)) {
      mkdirSync(dir(), {recursive: true, mode: 0o700});
      // Buffers a session never sent, from a host that was closed mid-turn.
      const old = Date.now() - 2 * 86400e3;
      for (const name of readdirSync(dir())) {
        const other = join(dir(), name);
        if (statSync(other).mtimeMs < old) rmSync(other, {force: true});
      }
    }
    appendFileSync(path, line + '\n', {mode: 0o600});
    // Reading what is waiting already keeps only the newest lines, so the file
    // is cut back only once it is well past that, not on every tool call.
    if (statSync(path).size > 4 * MAX_LINES * MAX_LINE) writeFileSync(path, pendingActions(sessionKey).join('\n') + '\n', {mode: 0o600});
  } catch { /* best effort */ }
}

/** What is waiting, oldest first. Never throws. */
export function pendingActions(sessionKey) {
  try {
    return readFileSync(fileOf(sessionKey), 'utf8').split('\n').filter(Boolean).slice(-MAX_LINES);
  } catch { return []; }
}

/** Drops the first `count` lines, the ones that were sent. A line added while
 *  the request was out stays for the next turn. */
export function clearActions(sessionKey, count) {
  try {
    const rest = pendingActions(sessionKey).slice(count);
    if (rest.length) writeFileSync(fileOf(sessionKey), rest.join('\n') + '\n', {mode: 0o600});
    else rmSync(fileOf(sessionKey), {force: true});
  } catch { /* best effort */ }
}
