#!/usr/bin/env node
// How well the Shelf sorts a capture: the profile, the topic, and the to-dos
// and events it finds, against eval/shelf-sort-cases.json, labelled blind.
//
//   node --env-file=.env eval/shelf-sort.mjs            the local prompt
//   node --env-file=.env eval/shelf-sort.mjs --prompt production
//
// A suggestion matches an expected one when the kind and the date agree and
// the titles share most of their words. "Dropped" counts what the model
// proposed with words that are not in the capture: settle() throws those away,
// so they never reach the person, but a prompt that makes many is a worse prompt.
import {readFileSync} from 'node:fs';
import {createSorter, settle} from '../server/shelf-sort.mjs';
import {askModel} from '../server/consolidator.mjs';
import {localTextFor, storedPrompt, SHELF_SORT_PROMPT} from '../server/prompt-store.mjs';

const args = process.argv.slice(2);
const which = args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : 'local';
const set = JSON.parse(readFileSync(new URL('./shelf-sort-cases.json', import.meta.url), 'utf8'));
const topics = set.topics.map((t, i) => ({id: `t${i + 1}`, name: t.name, profile: t.profile, brief: ''}));
const now = new Date(set.capture_time);

let proposed = 0;
const sorter = createSorter({
  promptResolver: which === 'local' ? async () => ({text: localTextFor(SHELF_SORT_PROMPT)}) : () => storedPrompt(SHELF_SORT_PROMPT, {label: which}),
  ask: async options => { const out = await askModel(options); proposed += out.object.suggestions.length; return out; },
});
if (!sorter) { console.error('No model key: set GEMINI_API_KEY.'); process.exit(2); }

const words = text => new Set((text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3));
const overlap = (a, b) => { const x = words(a), y = words(b); const both = [...x].filter(w => y.has(w)).length;
  return both / Math.max(1, Math.min(x.size, y.size)); };
const dayOf = s => s.due_date ?? (s.starts_at ? new Intl.DateTimeFormat('en-CA', {timeZone: set.timezone}).format(new Date(s.starts_at)) : null);
const timeOf = s => s.starts_at ? new Intl.DateTimeFormat('en-GB', {timeZone: set.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(s.starts_at)) : null;

const tally = {profileRight: 0, profileAsked: 0, nullGuessed: 0, nullCases: 0, topicRight: 0, topicCases: 0,
  expected: 0, got: 0, matched: 0, dateRight: 0, timeRight: 0, timeAsked: 0, quiet: 0, quietCases: 0, failed: 0,
  wantsExpected: 0, wantsGot: 0, wantsMatched: 0, wantsListRight: 0, noWantCases: 0, noWantClean: 0};
const misses = [];
for (const c of set.cases) {
  const item = {kind: c.kind, note: c.note ?? '', transcript: c.transcript ?? null, description: c.description ?? null};
  let out;
  try { out = await sorter.sort({item, topics, lists: set.lists ?? [], timezone: set.timezone, now}); }
  catch (e) { tally.failed++; misses.push(`${c.id} failed: ${e.message}`); continue; }
  const e = c.expect;
  if (e.profile) { tally.profileAsked++; if (out.profile === e.profile) tally.profileRight++; else misses.push(`${c.id} profile ${out.profile} ≠ ${e.profile}`); }
  else { tally.nullCases++; if (out.profile) tally.nullGuessed++; }
  if (e.topic) { tally.topicCases++; if (topics.find(t => t.id === out.topic_id)?.name === e.topic) tally.topicRight++; else misses.push(`${c.id} topic ≠ ${e.topic}`); }
  tally.expected += e.suggestions.length; tally.got += out.suggestions.length;
  if (!e.suggestions.length) { tally.quietCases++; if (!out.suggestions.length) tally.quiet++; else misses.push(`${c.id} should be quiet, got: ${out.suggestions.map(s => s.title).join('; ')}`); }
  const left = [...out.suggestions];
  for (const want of e.suggestions) {
    const i = left.findIndex(s => s.kind === want.kind && overlap(s.title, want.title) >= 0.4);
    if (i < 0) { misses.push(`${c.id} missed ${want.kind} "${want.title}"`); continue; }
    const got = left.splice(i, 1)[0];
    tally.matched++;
    if (dayOf(got) === want.date) tally.dateRight++; else misses.push(`${c.id} "${want.title}" date ${dayOf(got)} ≠ ${want.date}`);
    if (want.time) { tally.timeAsked++; if (timeOf(got) === want.time) tally.timeRight++; else misses.push(`${c.id} "${want.title}" time ${timeOf(got)} ≠ ${want.time}`); }
  }
  for (const extra of left) if (e.suggestions.length) misses.push(`${c.id} extra ${extra.kind} "${extra.title}"`);
  // List lines: matched on the title alone, then checked for the right list.
  const wanted = e.wants ?? [];
  const gotWants = [...(out.wants ?? [])];
  tally.wantsExpected += wanted.length; tally.wantsGot += gotWants.length;
  if (!wanted.length) { tally.noWantCases++; if (!gotWants.length) tally.noWantClean++; else misses.push(`${c.id} should add no lines, got: ${gotWants.map(w => w.title).join('; ')}`); }
  for (const want of wanted) {
    const i = gotWants.findIndex(w => overlap(w.title, want.title) >= 0.6);
    if (i < 0) { misses.push(`${c.id} missed ${want.list} "${want.title}"`); continue; }
    const got = gotWants.splice(i, 1)[0];
    tally.wantsMatched++;
    // "new" means none of their lists fits, so a new one should start; otherwise reuse that list by name.
    const existing = (set.lists ?? []).map(l => l.list.toLowerCase());
    const right = want.list === 'new' ? !existing.includes(got.list.toLowerCase()) : got.list.toLowerCase() === want.list;
    if (right) tally.wantsListRight++; else misses.push(`${c.id} "${want.title}" list ${got.list} ≠ ${want.list}`);
  }
  for (const extra of gotWants) if (wanted.length) misses.push(`${c.id} extra line ${extra.list} "${extra.title}"`);
}
const pct = (a, b) => b ? `${Math.round(100 * a / b)}% (${a}/${b})` : 'n/a';
console.log(`prompt: ${which}   cases: ${set.cases.length}   failed: ${tally.failed}`);
console.log(`profile right              ${pct(tally.profileRight, tally.profileAsked)}`);
console.log(`profile guessed when unclear ${pct(tally.nullGuessed, tally.nullCases)}`);
console.log(`topic right                ${pct(tally.topicRight, tally.topicCases)}`);
console.log(`suggestions found (recall) ${pct(tally.matched, tally.expected)}`);
console.log(`suggestions right (precision) ${pct(tally.matched, tally.got)}`);
console.log(`date right, of found       ${pct(tally.dateRight, tally.matched)}`);
console.log(`time right, of timed       ${pct(tally.timeRight, tally.timeAsked)}`);
console.log(`quiet when nothing to do   ${pct(tally.quiet, tally.quietCases)}`);
console.log(`list lines found           ${pct(tally.wantsMatched, tally.wantsExpected)}`);
console.log(`list lines right           ${pct(tally.wantsMatched, tally.wantsGot)}`);
console.log(`on the right list          ${pct(tally.wantsListRight, tally.wantsMatched)}`);
console.log(`no lines when none meant   ${pct(tally.noWantClean, tally.noWantCases)}`);
console.log(`dropped by the checks      ${proposed - tally.got} of ${proposed} proposed (words not in the capture, or an event with no day)`);
if (args.includes('--misses')) console.log('\n' + misses.join('\n'));
