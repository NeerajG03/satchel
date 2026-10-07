#!/usr/bin/env node
// Does the pass file work facts under topics, and reuse the topics it made.
//
//   GEMINI_API_KEY=... node eval/topics-replay.mjs --golden path/to/golden.json
//   GEMINI_API_KEY=... node eval/topics-replay.mjs --golden path/to/golden.json --off
//
// The golden file is a person's real memories, each with the one place a blind
// reader said it belongs: personal, a listed project, or a topic that does not
// exist yet. It holds real names, so it is not in the repository and is passed
// in by path.
//
// The memories are replayed one at a time, as if each came from its own
// session, and a topic the pass makes is listed for every session after it.
// That is the part a single case cannot show: whether the third fact about
// the same system lands in the topic the first one made, or makes another.
//
// --off replays with topics turned off, which is how the pass behaved before
// them. That is the baseline: every fact with no project falls into personal.
import {readFileSync} from 'node:fs';
import {createConsolidator} from '../server/consolidator.mjs';
import {localTextFor, CONSOLIDATE_PROMPT} from '../server/prompt-store.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null;
const goldenPath = flag('golden');
if (!goldenPath) { console.error('pass --golden <file>'); process.exit(2); }
const OFF = args.includes('--off');
const LIMIT = Number(flag('project-sample') ?? 8);
const MODEL = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.8-flash';
const THINKING = process.env.SATCHEL_THINKING_LEVEL ?? 'medium';
const PACE_MS = Number(process.env.CONSOLIDATION_EVAL_PACE_MS ?? 1500);
const wait = ms => new Promise(done => setTimeout(done, ms));

const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
const listed = new Set(golden.projects.map(p => p.slug));
// Everything that is not a listed project's own: personal, the new topics, and
// whatever sits in the wrong place today. Plus a few that are plainly a
// project's, so a pass that files everything under topics is caught too.
const loose = golden.memories.filter(m => m.golden === 'personal' || !listed.has(m.golden) || m.misplaced);
const owned = golden.memories.filter(m => !loose.includes(m)).slice(0, LIMIT);
const replay = [...loose, ...owned];

const consolidator = createConsolidator({model: MODEL, thinking: THINKING,
  promptResolver: async () => ({text: localTextFor(CONSOLIDATE_PROMPT), source: 'local', version: 'local'}),
  ...(process.env.GEMINI_API_KEY && !process.env.SATCHEL_ROUTER_URL ? {apiKey: process.env.GEMINI_API_KEY} : {})});

const projects = golden.projects.map(p => ({slug: p.slug, brief: p.brief}));
const made = [];
const rows = [];
console.log(`model ${MODEL} thinking ${THINKING} · topics ${OFF ? 'off' : 'on'} · ${replay.length} memories\n`);
for (const memory of replay) {
  const said = memory.source || memory.statement;
  let out;
  try {
    out = await consolidator.consolidate({now: new Date(), project: null, projects, memories: [],
      turns: [{id: 1, role: 'user', content: said, created_at: new Date().toISOString()}], newTopics: !OFF});
  } catch (error) {
    rows.push({memory, got: 'failed', why: error.reason ?? error.message});
    await wait(PACE_MS);
    continue;
  }
  for (const topic of out.topics ?? []) {
    projects.push(topic);
    made.push(topic);
  }
  const first = out.changes[0];
  rows.push({memory, got: first ? first.project ?? 'personal' : 'nothing'});
  await wait(PACE_MS);
}

// Right means: personal stays personal, a project's own stays in it, and a
// fact the golden reader gave a new topic lands in some topic that was made.
const isNew = slug => !listed.has(slug) && slug !== 'personal';
const right = row => row.got === 'nothing' ? false
  : listed.has(row.memory.golden) || row.memory.golden === 'personal' ? row.got === row.memory.golden
  : isNew(row.got) && made.some(t => t.slug === row.got);
const by = key => {
  const groups = new Map();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
};
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
for (const [label, list] of by(row => row.memory.golden === 'personal' ? 'personal'
  : listed.has(row.memory.golden) ? 'a listed project' : 'a new topic')) {
  const ok = list.filter(right).length;
  console.log(`  belongs in ${label.padEnd(16)} ${ok}/${list.length}  ${pct(ok, list.length)}`);
}
const ok = rows.filter(right).length;
console.log(`  ${'all'.padEnd(27)} ${ok}/${rows.length}  ${pct(ok, rows.length)}`);
const junk = rows.filter(r => r.memory.golden !== 'personal' && r.got === 'personal').length;
console.log(`  ${'work facts left in personal'.padEnd(27)} ${junk}`);

// Pairs that belong together should end up together. A topic made twice under
// two names splits a pair, and that is the sprawl this is watching for.
const fresh = rows.filter(r => !listed.has(r.memory.golden) && r.memory.golden !== 'personal');
let pairs = 0, kept = 0;
for (let i = 0; i < fresh.length; i++)
  for (let j = i + 1; j < fresh.length; j++)
    if (fresh[i].memory.golden === fresh[j].memory.golden) {
      pairs++;
      if (fresh[i].got === fresh[j].got && isNew(fresh[i].got)) kept++;
    }
console.log(`  ${'pairs kept together'.padEnd(27)} ${kept}/${pairs}`);
console.log(`  ${'topics made'.padEnd(27)} ${made.length}  (golden has ${golden.new_topics.length}): ${made.map(t => t.slug).join(', ') || 'none'}`);

console.log('\n  wrong:');
for (const row of rows.filter(r => !right(r)))
  console.log(`    wanted ${row.memory.golden.padEnd(18)} got ${String(row.got).padEnd(18)} ${row.memory.statement.slice(0, 60)}`);
