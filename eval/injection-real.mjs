#!/usr/bin/env node
// Does the agent see what a careful reader would show it, and nothing else.
//
//   node eval/injection-real.mjs
//   node eval/injection-real.mjs --checkout <dir>      score another tree's injection code
//   node eval/injection-real.mjs --only <session,...>
//   node eval/injection-real.mjs --update-baseline
//
// The golden set is built from production: collect-injections.mjs in the
// injection-review skill turns the person's own Claude Code sessions into
// moments (one prompt each), and labellers who never see what Satchel showed
// mark which memories each prompt needed. The sessions are private, so they
// live in SATCHEL_INJECTION_EVAL_DIR (default ~/satchel-daily/injection-eval)
// and only this runner and its scoring are committed.
//
// Every session is replayed through the real sessionStart and retrieve from
// server/lifecycle.mjs, against a frozen copy of the memory set, with the
// database search swapped for the twin in eval/lib/injection-twin.mjs. Prompt
// vectors come from a cache, so a run makes no model call unless a change to
// the classifier asks for a query the cache has never seen; that one is
// embedded once and kept.
//
// Production is scored too, from what the transcripts say was injected, so
// the first column is what people actually got and the second is what this
// code would give them.
import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {replayService, time} from './lib/injection-twin.mjs';
import {promptKey, promptEmbedder} from './lib/injection-cache.mjs';
import {summarise, pair, gate} from './lib/injection-scoring.mjs';
import {paired} from './lib/metrics.mjs';

const DIR = process.env.SATCHEL_INJECTION_EVAL_DIR ?? join(process.env.HOME, 'satchel-daily', 'injection-eval');
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const CHECKOUT = flag('checkout') ?? join(import.meta.dirname, '..');
const ONLY = flag('only')?.split(',');
const read = path => JSON.parse(readFileSync(join(DIR, path), 'utf8'));

if (!existsSync(join(DIR, 'snapshot.json'))) throw new Error(`no corpus in ${DIR}; run collect-injections.mjs first`);
const {sessionStart, retrieve} = await import(join(CHECKOUT, 'server/lifecycle.mjs'));
const {handleOf, estimateTokens} = await import(join(CHECKOUT, 'server/injection-format.mjs'));
const {scrub} = await import(join(CHECKOUT, 'server/secrets.mjs'));
// The hook's half of the skip list, when the checkout has one: the ids each
// prompt was shown, sent back as `exclude` until a compact or a clear. Replayed
// with the plugin's own rule, so a change to it is measured like any other.
const plugin = existsSync(join(CHECKOUT, 'integrations/shared/shown.mjs'))
  ? await import(join(CHECKOUT, 'integrations/shared/shown.mjs')) : null;
// What handleHookRetrieve does to a prompt before retrieve sees it. The host
// hands the hook the prompt without the reminders the transcript wraps round
// it, so those come off first, or a long one would push the request past the cut.
const REMINDER = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/g;
const asSent = text => scrub(String(text).replace(REMINDER, '').trim().slice(0, 4000));

const snapshot = read('snapshot.json');
// --set gate=0.72 --set per_prompt_matches=3: score a settings proposal without
// touching the memory_settings row, which only the person may change.
const overrides = args.flatMap((a, i) => a === '--set' ? [args[i + 1]] : []).map(kv => kv.split('='));
for (const [key, value] of overrides) {
  if (!(key in snapshot.settings)) throw new Error(`no setting called ${key}`);
  snapshot.settings[key] = Number.isNaN(Number(value)) ? value : Number(value);
}
const vectors = read('vectors/memories.json');
const cache = read('vectors/prompts.json');
const byId = new Map(snapshot.memories.map(m => [m.id, m]));
const byHandle = new Map();
for (const m of snapshot.memories) { const h = handleOf(m.id); byHandle.set(h, byHandle.has(h) ? null : m.id); }
const bySlug = new Map(snapshot.topics.map(t => [t.slug, t.id]));
const endedBy = (id, at) => { const m = byId.get(id); return Boolean(m?.ended_at && time(m.ended_at) <= time(at)); };
const isEnded = id => endedBy(id, snapshot.taken_at);

// ---- gold ---------------------------------------------------------------------

const unknown = new Set();
let endedInGold = 0;
const toIds = handles => (handles ?? []).map(h => {
  const id = byHandle.get(String(h).toLowerCase().trim());
  if (!id) unknown.add(h);
  return id;
}).filter(Boolean);
function loadGold(prefix) {
  const out = new Map();
  for (const file of readdirSync(join(DIR, 'gold')).filter(f => f.startsWith(prefix) && f.endsWith('.json')))
    for (const s of read(`gold/${file}`)) {
      const topic = s.topic ? bySlug.get(s.topic) ?? null : null;
      for (const p of s.prompts ?? []) {
        // A memory ended since labelling cannot be needed any more, and
        // showing it now would hand the agent something no longer true.
        const must = toIds(p.must), helps = toIds(p.helps), traps = toIds(p.traps);
        const ended = [...must, ...helps].filter(isEnded);
        endedInGold += ended.length;
        out.set(`${s.session}:${p.n}`, {
          must: must.filter(id => !isEnded(id)), helps: helps.filter(id => !isEnded(id)),
          traps: [...traps, ...ended],
          topic: p.topic !== undefined ? (p.topic ? bySlug.get(p.topic) ?? null : null) : topic,
        });
      }
    }
  return out;
}
const gold = loadGold('gold-');
const check = loadGold('check-');

// ---- prompt vectors --------------------------------------------------------------

let embedder = null, embeddedNow = 0;
async function queryVector(text) {
  const key = promptKey(text);
  if (cache[key]) return cache[key];
  embedder ??= await promptEmbedder();
  cache[key] = await embedder.embedOne(text, 'query');
  embeddedNow++;
  return cache[key];
}

// ---- replay -----------------------------------------------------------------------

const sessions = readdirSync(join(DIR, 'sessions')).map(f => read(`sessions/${f}`))
  .filter(s => !ONLY || ONLY.some(o => s.session.startsWith(o)))
  .sort((a, b) => String(a.first).localeCompare(String(b.first)));

const resets = new Set(['startup', 'clear', 'compact', null, undefined]);
const linkCount = repository => repository ? snapshot.links.filter(l => l.repository === repository).length : 0;
const replayed = [], production = [];
for (const s of sessions) {
  const service = replayService({snapshot, vectors, queryVector});
  let front = new Set(), shipFront = new Set(), shipActive = null, sent = [];
  for (const e of s.events) {
    if (e.kind === 'start') {
      if (resets.has(e.how)) { front = new Set(); shipFront = new Set(); }
      if (plugin?.RESETS.has(e.how)) sent = [];
      const mark = service.log.length;
      await sessionStart(service, {sessionKey: s.session, repository: s.repository});
      for (const entry of service.log.slice(mark)) for (const id of entry.memory_ids) front.add(id);
      for (const id of e.loaded ?? []) shipFront.add(id);
      shipActive = e.active ?? shipActive;
    } else if (e.kind === 'select' && e.ok !== false && e.topic_id) {
      service.state.active = e.topic_id;
      shipActive = e.topic_id;
    } else if (e.kind === 'prompt') {
      const id = `${s.session}:${e.n ?? e.uuid}`;
      const g = e.typed ? gold.get(`${s.session}:${e.n}`) ?? null : null;
      const mark = service.log.length;
      const prompt = asSent(e.text);
      const out = prompt
        ? await retrieve(service, {sessionKey: s.session, prompt, repository: s.repository, exclude: sent})
        : {context: ''};
      const shown = service.log.slice(mark).flatMap(entry => entry.memory_ids);
      if (plugin) sent = plugin.remember(sent, out.shown ?? shown);
      replayed.push({id, session: s.session, n: e.n, typed: e.typed, gold: g, shown, before: [...front], links: linkCount(s.repository),
        active: service.state.active, tokens: out.context ? estimateTokens(out.context) : 0});
      for (const m of shown) front.add(m);
      const shipShown = e.shown ?? [];
      production.push({id, session: s.session, n: e.n, typed: e.typed, gold: g,
        shown: shipShown.filter(m => !endedBy(m, e.ts)),
        ended: shipShown.filter(m => endedBy(m, e.ts)),
        before: [...shipFront], active: shipActive, tokens: e.shownText ? estimateTokens(e.shownText) : 0});
      for (const m of shipShown) shipFront.add(m);
    }
  }
}
if (embeddedNow) writeFileSync(join(DIR, 'vectors', 'prompts.json'), JSON.stringify(cache));

// ---- report ---------------------------------------------------------------------------

const now = summarise(replayed);
const ship = summarise(production);
const baselinePath = join(DIR, 'baseline.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;

const pct = v => v == null ? '-' : `${(100 * v).toFixed(1)}%`;
const num = v => v == null ? '-' : String(v);
const rows = [
  ['reached', 'must memories in front of the agent', pct],
  ['helpsReached', 'helps memories in front of the agent', pct],
  ['clean', 'prompt slots that were needed', pct],
  ['quiet', 'prompts needing nothing that got nothing', pct],
  ['hostQuiet', 'host messages that got nothing', pct],
  ['repeat', 'prompt slots already in front', pct],
  ['topicRight', 'prompts on the right topic', pct],
  ['tokens', 'median tokens of a prompt block', num],
  ['slots', 'prompt slots shown', num],
  ['harmful', 'traps or ended memories shown (bar is 0)', num],
  ['utility', 'headline, per typed prompt', v => v == null ? '-' : v.toFixed(3)],
];
console.log(`injection eval · ${sessions.length} sessions · ${now.typed} labelled prompts (${now.answerable} needed something) · ${now.host} host messages`);
console.log(`snapshot ${snapshot.taken_at.slice(0, 10)} · checkout ${CHECKOUT}${embeddedNow ? ` · ${embeddedNow} new query vectors` : ''}`
  + (overrides.length ? ` · settings ${overrides.map(kv => kv.join('=')).join(', ')}` : ''));
if (unknown.size) console.log(`gold names ${unknown.size} handles that are not in the snapshot: ${[...unknown].slice(0, 8).join(', ')}`);
if (endedInGold) console.log(`${endedInGold} gold labels name memories ended since; counted as traps`);
const unlabelled = replayed.filter(r => r.typed && !r.gold).length;
if (unlabelled) console.log(`${unlabelled} typed prompts have no label yet and are not scored`);
console.log('');
console.log(`  ${''.padEnd(56)} ${'production'.padStart(11)} ${'replay'.padStart(9)} ${'baseline'.padStart(9)}`);
for (const [key, label, fmt] of rows)
  console.log(`  ${`${key}  ${label}`.padEnd(56)} ${fmt(ship[key]).padStart(11)} ${fmt(now[key]).padStart(9)} ${fmt(baseline?.summary?.[key]).padStart(9)}`);

// What to look at first: the memories that cost the most room, the ones most
// often needed and missing, and every harmful slot.
const tally = (moments, pick) => {
  const counts = new Map();
  for (const m of moments) for (const id of pick(m)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
};
const label = id => { const m = byId.get(id); return `${handleOf(id)}  ${String(m?.statement ?? '').slice(0, 80)}`; };
const graded = m => new Set([...(m.gold?.must ?? []), ...(m.gold?.helps ?? [])]);
console.log('\n  shown and not needed, replay:');
for (const [id, n] of tally(replayed.filter(m => m.gold), m => m.shown.filter(x => !graded(m).has(x)))) console.log(`    ${String(n).padStart(4)}  ${label(id)}`);
console.log('\n  needed and not in front of the agent, replay:');
for (const [id, n] of tally(replayed.filter(m => m.gold), m => m.gold.must.filter(x => !m.shown.includes(x) && !m.before.includes(x)))) console.log(`    ${String(n).padStart(4)}  ${label(id)}`);
// Where the misses live. A repository linked to several topics never picks
// one, so its sessions run unscoped; that is the first thing to look at when
// reached or topic right is low.
console.log('\n  by how the repository is linked, replay:');
console.log(`    ${''.padEnd(22)} ${'prompts'.padStart(8)} ${'reached'.padStart(8)} ${'clean'.padStart(7)} ${'quiet'.padStart(7)} ${'topic'.padStart(7)} ${'utility'.padStart(8)}`);
for (const [name, pick] of [['no repository link', n => n === 0], ['one topic', n => n === 1], ['several topics', n => n > 1]]) {
  const part = summarise(replayed.filter(m => pick(m.links)));
  console.log(`    ${name.padEnd(22)} ${String(part.typed).padStart(8)} ${pct(part.reached).padStart(8)} ${pct(part.clean).padStart(7)} ${pct(part.quiet).padStart(7)} ${pct(part.topicRight).padStart(7)} ${(part.utility ?? 0).toFixed(3).padStart(8)}`);
}
const harmful = replayed.filter(m => m.gold && m.shown.some(x => m.gold.traps.includes(x)));
if (harmful.length) {
  console.log('\n  traps shown, replay:');
  for (const m of harmful.slice(0, 10)) console.log(`    ${m.id.slice(0, 8)} P${m.n}  ${m.shown.filter(x => m.gold.traps.includes(x)).map(label).join(' | ')}`);
}

// The second labeller, where there is one.
//
// Two careful readers disagree a lot about which memories a vague prompt
// ("merged it, what next?") could use: on the first golden set they matched on
// a third of the "must" calls. So the absolute numbers carry the labeller's
// taste, and they are printed under both sets of labels to show how much.
//
// That noise does not lean towards either version of the code, and a change is
// judged by comparing two versions on the same labels. What would make the
// gold useless is the two labellers disagreeing about which version is better.
// So that is the check: every number must move the same way, production to
// replay, under both. A flip means the gold cannot tell those two apart.
let overlap = null;
if (check.size) {
  const ids = new Set([...check.keys()].filter(key => gold.has(key)));
  const relabel = moments => moments.filter(m => ids.has(m.id)).map(m => ({...m, gold: check.get(m.id)}));
  const keep = moments => moments.filter(m => ids.has(m.id));
  const card = {shipA: summarise(keep(production)), nowA: summarise(keep(replayed)),
    shipB: summarise(relabel(production)), nowB: summarise(relabel(replayed))};
  const keys = ['reached', 'clean', 'quiet', 'utility'];
  const flips = keys.filter(k => [card.shipA[k], card.nowA[k], card.shipB[k], card.nowB[k]].every(v => v != null)
    && Math.sign(card.nowA[k] - card.shipA[k]) !== Math.sign(card.nowB[k] - card.shipB[k])
    // Under two points either way is the same answer: no real change.
    && Math.abs(card.nowA[k] - card.shipA[k]) >= 0.02 && Math.abs(card.nowB[k] - card.shipB[k]) >= 0.02);
  overlap = {prompts: ids.size, flips};
  console.log(`\n  second labeller, on the ${ids.size} prompts both labelled (production -> replay):`);
  for (const k of keys)
    console.log(`    ${k.padEnd(9)} first ${pct(card.shipA[k])} -> ${pct(card.nowA[k])}   second ${pct(card.shipB[k])} -> ${pct(card.nowB[k])}${flips.includes(k) ? '   the two disagree on direction' : ''}`);
  console.log(flips.length ? `  the labellers disagree on which is better for ${flips.join(', ')}: do not gate on those`
    : '  both labellers agree on which is better on every number');
  // Kept per prompt so a later run can ask the same question of its own change.
  for (const r of now.rows) if (ids.has(r.id)) {
    const m = replayed.find(x => x.id === r.id);
    r.checkUtility = summarise([{...m, gold: check.get(r.id)}]).rows[0].utility;
  }
}

// The gate, against the baseline, on the prompts both runs scored.
let verdict = null;
// A baseline taken on another snapshot measured another memory set, so a
// difference would be the data moving, not the code. Score main again first.
const comparable = baseline && baseline.snapshot === snapshot.taken_at;
if (baseline && !comparable)
  console.log(`\n  the baseline is from the ${String(baseline.snapshot).slice(0, 16)} snapshot, not this one: run main with --update-baseline, then this checkout`);
if (comparable) {
  const {a, b, compared, unmatched} = pair(now.rows, baseline.rows);
  const significance = compared > 1 ? paired(a, b) : null;
  verdict = gate(now, baseline.summary, significance);
  // The same change judged on the second labeller's labels. If the two point
  // different ways, the change is inside the labellers' disagreement.
  const was = new Map(baseline.rows.filter(r => r.checkUtility != null).map(r => [r.id, r.checkUtility]));
  const both = now.rows.filter(r => r.checkUtility != null && was.has(r.id));
  if (both.length > 1 && significance) {
    const second = paired(both.map(r => r.checkUtility), both.map(r => was.get(r.id)));
    const first = paired(both.map(r => r.utility), both.map(r => baseline.rows.find(x => x.id === r.id).utility));
    const agree = Math.sign(first.delta) === Math.sign(second.delta) || (!first.significant && !second.significant);
    console.log(`  on the ${both.length} double-labelled prompts: first labeller ${first.delta >= 0 ? '+' : ''}${first.delta.toFixed(3)}, second ${second.delta >= 0 ? '+' : ''}${second.delta.toFixed(3)}${agree ? '' : '  · they disagree'}`);
    if (!agree) verdict.reasons.push('the two labellers disagree on the direction');
    verdict.pass = verdict.reasons.length === 0;
  }
  console.log(`\n  against baseline on ${compared} prompts${unmatched ? ` (${unmatched} new since)` : ''}: utility ${significance ? `${significance.delta >= 0 ? '+' : ''}${significance.delta.toFixed(3)} [${significance.lo.toFixed(3)}, ${significance.hi.toFixed(3)}]${significance.significant ? '' : ' noise'}` : '-'}`);
  console.log(`  gate: ${verdict.pass ? 'pass' : `fail · ${verdict.reasons.join('; ')}`}`);
}

const strip = s => { const {rows: _rows, ...rest} = s; return rest; };
const record = {at: new Date().toISOString(), checkout: CHECKOUT, snapshot: snapshot.taken_at,
  summary: strip(now), production: strip(ship),
  overlap, rows: now.rows.map(r => ({id: r.id, labelled: r.labelled, utility: r.utility ?? null,
    ...(r.checkUtility != null ? {checkUtility: r.checkUtility} : {})}))};
writeFileSync(join(DIR, 'runs', `run-${record.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(record));
if (args.includes('--update-baseline') && overrides.length) throw new Error('a baseline is the settings as they are; drop --set');
if (args.includes('--update-baseline')) {
  writeFileSync(baselinePath, JSON.stringify(record));
  console.log('\n  baseline updated');
}
if (verdict && !verdict.pass && !args.includes('--update-baseline')) process.exitCode = 1;
