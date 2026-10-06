#!/usr/bin/env node
// Does the consolidation pass find what a careful reader finds in the
// person's own conversations.
//
//   GEMINI_API_KEY=... node eval/consolidation-real.mjs
//   GEMINI_API_KEY=... node eval/consolidation-real.mjs --only 8168b5f6 --repeat 3
//   GEMINI_API_KEY=... node eval/consolidation-real.mjs --update-baseline
//
// The synthetic suite (consolidation.mjs) checks rules a person wrote down in
// advance. This one is built from production: collect-corpus.mjs in the
// daily-improvement skill pulls whole conversations, and labellers who never
// see the pass's answer write the memories those conversations justify. The
// conversations are private, so they live in SATCHEL_REAL_EVAL_DIR (default
// ~/satchel-daily/real-eval) and never in the repository. Only this runner and
// its scoring are committed.
//
// Every session starts from an empty memory set. That measures whether the
// pass finds a memory at all. Whether it extends, affirms or replaces one that
// exists is what the synthetic suite is for.
//
// The baseline is stored beside the data, not here: it is a number about a
// private corpus.
import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {createConsolidator} from '../server/consolidator.mjs';
import {consolidatePrompt, localTextFor, CONSOLIDATE_PROMPT} from '../server/prompt-store.mjs';
import {scrub} from '../server/secrets.mjs';
import {firstChunk} from '../server/turn-chunks.mjs';
import {scoreSession, summarise, applyMatches} from './lib/real-scoring.mjs';
import {makeJudge} from './lib/real-judge.mjs';

const dir = process.env.SATCHEL_REAL_EVAL_DIR ?? join(process.env.HOME, 'satchel-daily', 'real-eval');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null;
const ONLY = flag('only');
const REPEAT = Math.max(1, Number(flag('repeat') ?? 1));
const MODEL = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.8-flash';
const THINKING = process.env.SATCHEL_THINKING_LEVEL ?? 'medium';
const PACE_MS = Number(process.env.CONSOLIDATION_EVAL_PACE_MS ?? 1500);
const wait = ms => new Promise(done => setTimeout(done, ms));
const read = path => JSON.parse(readFileSync(join(dir, path), 'utf8'));

if (!existsSync(join(dir, 'sessions'))) throw new Error(`no corpus in ${dir}; run collect-corpus.mjs first`);
const projects = read('projects.json');
const gold = new Map();
for (const file of readdirSync(join(dir, 'gold')).filter(f => /^gold.*\.json$/.test(f)))
  for (const s of read(`gold/${file}`)) gold.set(s.session, s.memories ?? []);
const sessions = readdirSync(join(dir, 'sessions')).map(f => read(`sessions/${f}`))
  .filter(s => gold.has(s.name) && (!ONLY || ONLY.split(',').includes(s.name)));

const KEY = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY;
const judge = makeJudge({model: MODEL, apiKey: KEY, baseURL: process.env.SATCHEL_ROUTER_URL || undefined});

const instructions = {text: localTextFor(CONSOLIDATE_PROMPT), source: 'local', version: 'local'};
const consolidator = createConsolidator({
  model: MODEL, thinking: THINKING, fallback: null, promptResolver: async () => instructions,
  ...(process.env.GEMINI_API_KEY && !process.env.SATCHEL_ROUTER_URL ? {apiKey: process.env.GEMINI_API_KEY} : {}),
});

/** The whole session, in as many calls as production would make, each one seeing
 *  what the last one added. */
async function readSession(session) {
  const linked = projects.find(p => p.slug === session.project) ?? null;
  let unread = session.turns.map((t, i) => ({...t, id: i + 1, content: scrub(t.content)}));
  const memories = [];
  const changes = [];
  while (unread.length) {
    const turns = firstChunk(unread);
    unread = unread.slice(turns.length);
    const out = await consolidator.consolidate({
      now: new Date(session.turns.at(-1).created_at),
      project: linked, projects: projects.filter(p => p.slug !== linked?.slug),
      memories, turns,
    });
    for (const change of out.changes.map(c => ({...c, project: c.project ?? null}))) {
      changes.push(change);
      if (change.action === 'add')
        memories.push({id: `m${memories.length + 1}`, statement: change.statement, kind: change.kind,
          project_slug: change.project, revision: 1, mentions: 1, commits_since: null});
    }
  }
  return changes;
}

console.log(`prompt ${instructions.text.length} characters · model ${MODEL} thinking ${THINKING} · `
  + `${sessions.length} sessions · ${REPEAT} run(s) each\n`);
const scored = [];
const keywordScored = [];
const log = [];
let failed = 0;
for (const session of sessions) {
  for (let run = 0; run < REPEAT; run++) {
    try {
      const changes = await readSession(session);
      const keyword = scoreSession(gold.get(session.name), changes);
      // Keywords are strict, so what they missed gets a second look from a
      // model, and both numbers are printed.
      const open = keyword.rows.map((r, i) => ({r, i})).filter(x => !x.r.found);
      let pairs = [];
      try {
        pairs = (await judge(open.map(x => x.r.gold), keyword.extra))
          .map(m => ({gold: open[m.gold]?.i, claim: m.claim}));
      } catch (error) { console.log(`  ${session.name} judge failed: ${String(error.message).slice(0, 60)}`); }
      const result = applyMatches(keyword, pairs);
      keywordScored.push(keyword);
      scored.push(result);
      log.push({session: session.name, changes: changes.map(c => ({action: c.action, kind: c.kind,
        project: c.project, statement: c.statement})),
        missed: result.rows.filter(r => !r.found).map(r => r.gold.statement),
        extra: result.extra.map(c => c.statement)});
    } catch (error) {
      failed++;
      console.log(`  ${session.name} failed: ${(error.reason ?? error.message).slice(0, 80)}`);
    }
    await wait(PACE_MS);
  }
}

const sum = summarise(scored);
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
const strict = summarise(keywordScored);
console.log(`  by keywords alone: clear ${strict.clear.found}/${strict.clear.total}, all ${strict.all.found}/${strict.all.total}\n`);
console.log(`  found, clear memories   ${sum.clear.found}/${sum.clear.total}  ${pct(sum.clear.found, sum.clear.total)}`);
console.log(`  found, all memories     ${sum.all.found}/${sum.all.total}  ${pct(sum.all.found, sum.all.total)}`);
console.log(`  filed under right project  ${sum.project.right}/${sum.project.of}  ${pct(sum.project.right, sum.project.of)}`);
console.log(`  quiet sessions with a claim  ${sum.quiet.noisy}/${sum.quiet.total}`);
console.log(`  claims matching nothing (read them)  ${sum.extra}`);
if (failed) console.log(`  failed outright  ${failed}`);

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
writeFileSync(join(dir, `run-${stamp}.json`), JSON.stringify({model: MODEL, thinking: THINKING,
  prompt: instructions.text.length, repeat: REPEAT, summary: sum, sessions: log}, null, 1), {mode: 0o600});

const baselineFile = join(dir, 'baseline.json');
const current = {model: MODEL, thinking: THINKING, promptCharacters: instructions.text.length, repeat: REPEAT,
  clear: sum.clear, all: sum.all, project: sum.project, extra: sum.extra, quiet: sum.quiet};
if (existsSync(baselineFile) && !args.includes('--update-baseline')) {
  const before = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const rate = x => x.total ? x.found / x.total : 0;
  const moved = rate(current.clear) - rate(before.clear);
  console.log(`\n  against the baseline: clear ${pct(before.clear.found, before.clear.total)} -> `
    + `${pct(current.clear.found, current.clear.total)}, extra ${before.extra} -> ${current.extra}`);
  if (moved < -0.05) { console.log('  clear recall fell by more than five points'); process.exitCode = 1; }
} else if (args.includes('--update-baseline')) {
  writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n', {mode: 0o600});
  console.log('\n  baseline written beside the data');
}
