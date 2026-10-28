// The reply check: is the agent's last reply the kind the person asked for?
//
// People save preferences like "keep it short" and "no file names, I am not an
// engineer", and the agent breaks them anyway. A reminder at the start of the
// turn did not help in a test bench; one rewrite requested at the end of the
// turn did. So the end of the turn is where this runs, and it is plain code on
// purpose: no model call, no embedding, nothing that can be slow or cost money
// inside a hook that waits on it. Two things are measured, because those were
// the two things that kept breaking: length, and names only an engineer reads.
//
// Fenced code blocks are skipped for both. A person who asked for a script
// should get the script, and a reply that is only that block must pass.

const FENCE = /```[\s\S]*?(?:```|$)/g;
const EXTENSIONS = 'mjs|cjs|js|jsx|ts|tsx|json|md|sql|py|css|html|yml|yaml|toml|sh|rs|go|rb|lock|env|txt';
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

const TESTS = [
  // Inline code is the loudest sign: the agent is quoting an identifier.
  ['backticks', /`[^`\n]+`/],
  ['file names', new RegExp(`(?<![\\w@/-])[\\w.-]+\\.(?:${EXTENSIONS})\\b(?![\\w-])`, 'i')],
  // Three segments, or a leading ./ ~/ ../ , so "and/or" and "client/server" are left alone.
  // A letter somewhere, so a date like 28/10/2026 is not a path.
  ['paths', /(?<![\w/.:-])(?=[\w.~\/-]*[a-z])(?:(?:\.{1,2}|~)\/[\w.-]+(?:\/[\w.-]+)*|\/?[\w.-]+(?:\/[\w.-]+){2,})/],
  ['command flags', /(?<![\w-])--[a-z][\w-]*/],
  // Seven or more hex characters with both a digit and a letter, so a word
  // like "defaced" is not a commit.
  ['commit hashes', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
];

/** The reply as the person reads it: fenced blocks and links taken out. */
const prose = reply => reply.replace(FENCE, ' ').replace(URL, ' ');

// Only runs with a letter or a digit in them, so a table's borders are not words.
export const countWords = reply => (prose(reply).match(/\S+/g) ?? []).filter(word => /[\p{L}\p{N}]/u.test(word)).length;

/** `{ok: true}` when the reply is fine, otherwise `{ok: false, reason}` where
 *  the reason is one sentence the agent can act on. `wordLimit` is the
 *  person's own setting. */
export function checkReply(reply, {wordLimit = 200} = {}) {
  const text = typeof reply === 'string' ? reply : '';
  const body = prose(text);
  const words = countWords(text);
  const long = words > wordLimit;
  const found = TESTS.filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
  if (!long && !found.length) return {ok: true, words, found};
  const fixes = [];
  if (long) fixes.push(`under ${wordLimit} words`);
  if (found.length) fixes.push('no file or code names');
  return {ok: false, words, found, reason: `Satchel: rewrite your last reply for a non-engineer: ${fixes.join(', ')}.`};
}
