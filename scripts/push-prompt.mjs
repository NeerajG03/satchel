#!/usr/bin/env node
// Pushes the local copy of the capture prompt to Langfuse as a new version.
//
//   node scripts/push-prompt.mjs             # show what would change
//   node scripts/push-prompt.mjs --push      # create a version, label it production
//   node scripts/push-prompt.mjs --push --label staging
//
// One direction only. The file is where you edit, Langfuse is where it lives
// and where the history is. Nothing pulls a Langfuse version back over the
// file, because then two people editing in two places would silently pick a
// winner.
//
// A push with no change is refused rather than being a no-op version: version
// numbers are what a trace points at, and a run of identical versions makes
// "which wording produced this" unanswerable again.
import {localText, CAPTURE_PROMPT} from '../server/prompt-store.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1]?.startsWith('--') ? true : args[at + 1] ?? true);
};
const push = args.includes('--push');
const label = flag('label', 'production');

const baseUrl = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST;
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
if (!baseUrl || !publicKey || !secretKey) {
  console.error('Set LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.');
  console.error('They are in ~/.config/env. Read them out rather than sourcing the file.');
  process.exit(1);
}
const auth = {authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
  'content-type': 'application/json'};

const at = new URL(`/api/public/v2/prompts/${encodeURIComponent(CAPTURE_PROMPT)}`, baseUrl);
const live = await (async () => {
  const url = new URL(at);
  url.searchParams.set('label', label);
  const response = await fetch(url, {headers: auth});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Langfuse answered ${response.status} reading the prompt`);
  return response.json();
})();

console.log(`prompt  ${CAPTURE_PROMPT}`);
console.log(`label   ${label}`);
console.log(`live    ${live ? `version ${live.version}, ${String(live.prompt).length} characters` : 'nothing published yet'}`);
console.log(`local   ${localText.length} characters`);

if (live && String(live.prompt).trim() === localText) {
  console.log('\nThe published version is already this text. Nothing to push.');
  process.exit(0);
}
if (live) {
  // Line level, because a prompt is read as lines and a character diff of
  // prose is unreadable. The point is to make you look before you publish.
  const before = new Set(String(live.prompt).split('\n'));
  const after = new Set(localText.split('\n'));
  const added = localText.split('\n').filter(l => l.trim() && !before.has(l));
  const removed = String(live.prompt).split('\n').filter(l => l.trim() && !after.has(l));
  console.log(`\nchanged  +${added.length} lines  -${removed.length} lines`);
  for (const line of removed.slice(0, 8)) console.log(`  - ${line.slice(0, 110)}`);
  for (const line of added.slice(0, 8)) console.log(`  + ${line.slice(0, 110)}`);
}
if (!push) {
  console.log('\nDry run. Add --push to publish this as a new version.');
  process.exit(0);
}

const response = await fetch(new URL('/api/public/v2/prompts', baseUrl), {
  method: 'POST', headers: auth,
  body: JSON.stringify({
    name: CAPTURE_PROMPT,
    type: 'text',
    prompt: localText,
    labels: [label],
    // Read in Langfuse next to the version, so it is obvious which revision of
    // this repository the wording belongs to.
    commitMessage: flag('message', null) || undefined,
    tags: ['satchel', 'capture'],
  }),
});
if (!response.ok) {
  console.error(`\nLangfuse answered ${response.status}: ${(await response.text()).slice(0, 400)}`);
  process.exit(1);
}
const created = await response.json();
console.log(`\npublished version ${created.version} and moved the ${label} label to it`);
console.log('Deployed instances pick it up within SATCHEL_PROMPT_TTL_MS (an hour by default).');
