// Keys, passwords and tokens, taken out of what people say before it is kept.
//
// A conversation with a coding agent is full of them. People paste a
// connection string to ask why it will not connect, or an .env file to ask
// which line is wrong, and every hook then hands that text on: into the
// document, into the rolling window, into the embedder as a search query,
// into the trace, and six hours later into the consolidation model with the
// rest of the session. On 22 September two database passwords went all of
// those places inside one pasted paragraph.
//
// So this runs where the text comes in, once, and everything after it only
// ever sees the redacted copy. It is a pattern scanner and not a model on
// purpose: the shapes of real credentials are known and fixed, a regex is
// instant on the five second hook, and asking a hosted model whether
// something is a secret means sending it the secret.
//
// Two kinds of rule, and they fail in opposite directions.
//
//   shapes       a value that is a credential by its form alone: sk-..., ghp_...,
//                a private key block, a URL with a password in it. Near zero
//                false positives, so they are always taken out.
//   assignments  password=..., "apiKey": "...". The name says secret and the
//                value might be anything, including `fresh.accessToken` in a
//                line of code. So the value has to look random as well:
//                long, mixed, no dots between words. A missed secret here is
//                the cost of not mangling every code sample into noise.
//
// What comes back says what kind was found and never what it was. The label
// stays in the text so the conversation still reads: "why does
// [hidden: mongodb password] fail" is still a question about a password.

const hide = kind => `[hidden: ${kind}]`;

/** Shannon entropy per character. A random 20 character token sits around 4;
 *  an English identifier of the same length sits nearer 3. */
function entropy(text) {
  const seen = new Map();
  for (const char of text) seen.set(char, (seen.get(char) ?? 0) + 1);
  let bits = 0;
  for (const n of seen.values()) { const p = n / text.length; bits -= p * Math.log2(p); }
  return bits;
}

/** Whether a value that sits next to a secret-sounding name is itself one.
 *
 *  Letters and digits both, at least 12 long, and random enough. That leaves
 *  `process.env.GEMINI_API_KEY`, `fresh.accessToken` and `${token}` alone,
 *  which is most of what an agent writes next to the word "token". */
export function looksRandom(value) {
  if (value.length < 12) return false;
  if (/^[\p{L}_$][\p{L}\p{N}_$]*(\.[\p{L}_$][\p{L}\p{N}_$]*)+$/u.test(value)) return false;
  if (/^[$%{<]/.test(value) || /^(true|false|null|undefined|none|redacted|changeme|password)$/i.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return entropy(value) >= 3.2;
}

/** A stand-in somebody typed to show the shape, which is not a secret and is
 *  worth keeping: `mongodb+srv://user:pass@` is how people explain a URL. */
const placeholder = value =>
  /^(pass|password|passwd|pwd|secret|xxx+|\*+|\.{3}|changeme|example|<[^>]*>|\$\{[^}]*\}|\{[^}]*\}|\[[^\]]*\])$/i.test(value);

// Each shape is a credential by its form. Ordered so the specific ones claim
// their text before a general one does: an Anthropic key is also an `sk-` key,
// and should be named as the one it is.
const SHAPES = [
  // A whole private key, however many lines. Taken out whole: half of one is
  // still most of one.
  {kind: 'private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g},
  // A connection string keeps its scheme, user and host, which are what the
  // person was asking about, and loses the password between them.
  {kind: 'password', pattern: /\b((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqps?|mssql|sqlserver|ftp|sftp|smtp|https?):\/\/[^\s:/@'"`]+:)([^\s@'"`]+)(@)/gi,
    replace: (whole, head, password, at) => placeholder(password) ? whole
      : `${head}${hide(`${head.split(':')[0].toLowerCase().replace('+srv', '')} password`)}${at}`},
  {kind: 'anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g},
  {kind: 'langfuse key', pattern: /\b[sp]k-lf-[A-Za-z0-9-]{20,}/g},
  {kind: 'openrouter key', pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}/g},
  {kind: 'openai key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g},
  {kind: 'stripe key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g},
  {kind: 'github token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g},
  {kind: 'gitlab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g},
  {kind: 'slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g},
  {kind: 'google api key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g},
  {kind: 'aws access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g},
  {kind: 'supabase secret key', pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}/g},
  {kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g},
  // A JWT: three base64url parts, the first two of them JSON. Supabase's
  // service role key is one, and so is every access token.
  {kind: 'token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g},
  {kind: 'token', pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g,
    replace: (_, head) => `${head}${hide('token')}`},
];

// A name that says secret, then `=` or `:`, then the value, optionally quoted.
// Covers .env lines, JSON, YAML and code. The name can be part of a longer
// one: DB_PASSWORD, apiKey, client_secret.
const ASSIGNMENT = /((?:^|[^A-Za-z0-9])[A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credential|conn(?:ection)?[_-]?string)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)([^\s"',;`)}\]]+)/gi;

/** The text with every credential in it replaced by a label, and what kinds
 *  were taken out.
 *
 *  Never throws and never returns the values. `found` is safe to log; the
 *  input is not, which is the whole point of calling this first. */
export function redact(text) {
  if (typeof text !== 'string' || !text) return {text: text ?? '', found: []};
  const found = [];
  let out = text;
  for (const {kind, pattern, replace} of SHAPES) {
    out = out.replace(pattern, (...match) => {
      const replaced = replace ? replace(...match) : hide(kind);
      // A placeholder comes back untouched, and was not a find.
      if (replaced !== match[0]) found.push(kind);
      return replaced;
    });
  }
  out = out.replace(ASSIGNMENT, (whole, head, value) => {
    // Already a label, from a shape above. Counting it twice would say two
    // secrets where there was one.
    if (value.startsWith('[hidden')) return whole;
    if (!looksRandom(value)) return whole;
    found.push('secret');
    return `${head}${hide('secret')}`;
  });
  return {text: out, found};
}

/** Just the text, for the places that do not report what was found. */
export const scrub = text => redact(text).text;
