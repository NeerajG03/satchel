#!/usr/bin/env node
// Does the nightly tidy move work facts out of personal, and only those.
//
//   GEMINI_API_KEY=... node eval/tidy-replay.mjs --golden path/to/golden.json --repeat 3
//
// The same golden file as topics-replay.mjs: real memories, each placed by a
// blind reader. This shows the tidy what sits in personal today and the
// listed topics, as the overnight job would, and scores what it moves. One
// call per run, so repeating it is cheap and the only way to see noise.
import {readFileSync} from 'node:fs';
import {createTidier} from '../server/tidy.mjs';
import {localTextFor, TIDY_PROMPT} from '../server/prompt-store.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null;
const goldenPath = flag('golden');
if (!goldenPath) { console.error('pass --golden <file>'); process.exit(2); }
const REPEAT = Math.max(1, Number(flag('repeat') ?? 1));
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
const listed = new Set(golden.topics.map(p => p.slug));
const topics = golden.topics.map(p => ({id: p.slug, slug: p.slug, brief: p.brief, made_by: 'person'}));
const memories = golden.memories.filter(m => m.current_scope === 'personal')
  .map(m => ({id: m.id, statement: m.statement, kind: m.kind, revision: 1, golden: m.golden}));

const tidier = createTidier({
  promptResolver: async () => ({text: localTextFor(TIDY_PROMPT), source: 'local'}),
  ...(process.env.GEMINI_API_KEY && !process.env.SATCHEL_ROUTER_URL ? {apiKey: process.env.GEMINI_API_KEY} : {})});

console.log(`model ${tidier.model} · ${memories.length} personal memories · ${REPEAT} run(s)\n`);
for (let run = 1; run <= REPEAT; run++) {
  const out = await tidier.tidy({topics, memories});
  const placed = new Map(out.moves.map(m => [m.memory.id, m.slug]));
  const rows = memories.map(m => ({m, got: placed.get(m.id) ?? 'personal'}));
  const right = r => r.m.golden === 'personal' ? r.got === 'personal'
    : listed.has(r.m.golden) ? r.got === r.m.golden : r.got !== 'personal' && !listed.has(r.got);
  const stay = rows.filter(r => r.m.golden === 'personal');
  const go = rows.filter(r => r.m.golden !== 'personal');
  let pairs = 0, kept = 0;
  for (let i = 0; i < go.length; i++) for (let j = i + 1; j < go.length; j++)
    if (go[i].m.golden === go[j].m.golden) { pairs++; if (go[i].got === go[j].got) kept++; }
  console.log(`run ${run}`);
  console.log(`  stayed in personal, should   ${stay.filter(right).length}/${stay.length}`);
  console.log(`  moved, should                ${go.filter(right).length}/${go.length}`);
  console.log(`  pairs kept together          ${kept}/${pairs}`);
  console.log(`  new topics                   ${out.named.map(t => t.slug).join(', ') || 'none'}`);
  for (const r of rows.filter(r => !right(r)))
    console.log(`    wanted ${r.m.golden.padEnd(16)} got ${r.got.padEnd(16)} ${r.m.statement.slice(0, 60)}`);
}
