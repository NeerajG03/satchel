// Where the router's instructions live.
//
// They used to be a template literal in router.mjs, which meant every wording
// change was a deploy, and a trace six weeks old could not tell you which
// wording produced it. Both of those matter more here than anywhere else in
// the system: the instructions are the only thing standing between a work
// order and a stored memory, and the evidence that a change helped is a set of
// traces recorded before and after it.
//
// So the prompt lives in Langfuse, versioned and labelled, and the copy in
// server/prompts/ is the editing surface and the fallback. The rule is one
// direction only: edit the file, run scripts/push-prompt.mjs, and Langfuse has
// a new version. Nothing here writes, and nothing edits the file back.
//
// Three properties this has to keep, in this order:
//   1. Capture never fails because Langfuse is slow, down or unconfigured.
//      The committed file answers in that case, and it is a real answer, not
//      a degraded one.
//   2. Whatever was used is named on the trace, so a capture can be explained.
//   3. One fetch per warm instance, not one per turn.
import {readFileSync} from 'node:fs';

/** The names prompts have in Langfuse. Changing one orphans its history. */
export const CAPTURE_PROMPT = 'satchel-capture-router';
export const CONSOLIDATE_PROMPT = 'satchel-consolidate';

// Read at import, not per call. It is a few kilobytes and it is needed on
// every cold start anyway, as the fallback if nothing else.
//
// vercel.json lists server/prompts/** under includeFiles so this survives the
// serverless bundle. A missing file here would not throw until the first
// capture, which is exactly the kind of failure that hides.
const read = file => readFileSync(new URL(`./prompts/${file}`, import.meta.url), 'utf8').trim();

/** Which file backs which name. One map, so a prompt that exists in Langfuse
 *  and not on disk cannot be reached at all: the fallback is the contract. */
export const PROMPT_FILES = {
  [CAPTURE_PROMPT]: 'capture-router.md',
  [CONSOLIDATE_PROMPT]: 'consolidate.md',
};

export const localText = read(PROMPT_FILES[CAPTURE_PROMPT]);
export const localTextFor = name => read(PROMPT_FILES[name]);

const HOUR = 3600_000;
// Per name. One shared slot meant the second prompt to ask would be handed the
// first one's text, which is the kind of bug that looks like a bad model.
const cached = new Map();

/** The instructions to send, and where they came from.
 *
 *  Never throws and never returns nothing: the worst case is the committed
 *  file with `source: 'local'`, which is the same text this repo was tested
 *  against. */
export const capturePrompt = options => storedPrompt(CAPTURE_PROMPT, options);
export const consolidatePrompt = options => storedPrompt(CONSOLIDATE_PROMPT, options);

export async function storedPrompt(name, {
  baseUrl = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST,
  publicKey = process.env.LANGFUSE_PUBLIC_KEY,
  secretKey = process.env.LANGFUSE_SECRET_KEY,
  // Which version production runs. A new push is labelled `production`, so
  // rolling back is relabelling in Langfuse rather than a deploy.
  label = process.env.SATCHEL_PROMPT_LABEL ?? 'production',
  // Short on purpose. This sits in front of a capture that already has an 8
  // second budget, and the fallback is not a worse answer, just an older one.
  timeoutMs = Number(process.env.SATCHEL_PROMPT_TIMEOUT_MS ?? 1500),
  ttlMs = Number(process.env.SATCHEL_PROMPT_TTL_MS ?? HOUR),
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const fallback = {text: localTextFor(name), source: 'local', version: null, label: null};
  if (!baseUrl || !publicKey || !secretKey) return fallback;
  const held = cached.get(name);
  if (held && now() - held.at < ttlMs) return held.value;
  try {
    const url = new URL(`/api/public/v2/prompts/${encodeURIComponent(name)}`, baseUrl);
    url.searchParams.set('label', label);
    const response = await fetchImpl(url, {
      headers: {authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}`},
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A 404 is the ordinary state before the first push, not a fault. Cached
    // like a hit so a repo that has never pushed does not spend a request per
    // hour learning the same thing.
    if (!response.ok) return remember(name, fallback, now);
    const body = await response.json();
    const text = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    // An empty or malformed prompt is worse than an old one. Anything that is
    // not plainly a text prompt falls back rather than being sent.
    if (!text) return remember(name, fallback, now);
    return remember(name, {text, source: 'langfuse', version: body.version ?? null, label}, now);
  } catch {
    // Timeout, DNS, a bad key: all the same decision. The file is right here.
    return remember(name, fallback, now);
  }
}

function remember(name, value, now) {
  cached.set(name, {value, at: now()});
  return value;
}

/** Tests and long-lived processes that change environment between runs. */
export function resetPromptCache() { cached.clear(); }
