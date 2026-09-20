#!/usr/bin/env node
// Measures capture, the other half of the system. Retrieval can only pick the
// least bad row available, so what gets written matters more than how it is
// found.
//
//   OPENROUTER_API_KEY=... node eval/router.mjs [model ...]
//
// The corpus is already the test set: every memory carries `source`, the messy
// thing the person typed, and `statement`, what it should have become. So a
// turn can be replayed and the answer compared. Prompts with no answer stand in
// for turns that should produce nothing, which is the harder half.
import {corpus, answerless, promptById} from './lib/data.mjs';
import {createRouter} from '../server/router.mjs';
import {mean} from './lib/metrics.mjs';

const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'google/gemma-4-26b-a4b-it:free',
  'liquid/lfm-2.5-2.6b:free',
];
const POSITIVES = 24;
const NEGATIVES = 16;

const projects = corpus.projects.map(p => ({slug: p.slug, brief: p.brief}));
const openTasks = corpus.tasks.filter(t => t.status !== 'done')
  .slice(0, 12).map(t => ({slug: t.slug, title: t.title, project: t.project}));

// A deterministic spread rather than a random one, so two runs compare.
const pick = (list, n) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0).slice(0, n);
const positives = pick(corpus.memories.filter(m => m.source?.trim().length > 25), POSITIVES);
const negatives = pick(answerless.map(id => promptById.get(id)), NEGATIVES);

// Word overlap, not similarity: the question is whether the claim survived,
// and an embedding call per item would make this eval depend on the other one.
function overlap(a, b) {
  const words = t => new Set(String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.max(x.size, y.size);
}

const wait = ms => new Promise(done => setTimeout(done, ms));

for (const model of MODELS) {
  const router = createRouter({model});
  const result = {extracted: 0, faithful: [], projectRight: 0, projectTotal: 0,
    quiet: 0, noisy: 0, failed: 0, items: [], latency: []};
  console.log(`\n${model}`);

  for (const memory of positives) {
    const turn = [memory.source];
    const started = Date.now();
    try {
      const out = await router.route({projects, tasks: openTasks, context: [], turn});
      result.latency.push(Date.now() - started);
      if (out.memories.length) {
        result.extracted++;
        const best = out.memories.map(m => overlap(m.statement, memory.statement))
          .sort((a, b) => b - a)[0];
        result.faithful.push(best);
        if (memory.project) {
          result.projectTotal++;
          if (out.memories.some(m => m.project === memory.project)) result.projectRight++;
        }
        result.items.push({got: out.memories[0].statement, want: memory.statement, dropped: out.dropped.length});
      }
    } catch (error) { result.failed++; }
    await wait(3200); // 20 requests a minute on the free tier
  }

  for (const prompt of negatives) {
    try {
      const out = await router.route({projects, tasks: openTasks, context: [], turn: [prompt.text]});
      if (out.memories.length) result.noisy++; else result.quiet++;
    } catch { result.failed++; }
    await wait(3200);
  }

  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
  console.log(`  extracted a memory   ${result.extracted}/${positives.length}  ${pct(result.extracted, positives.length)}`);
  console.log(`  statement overlap    ${mean(result.faithful).toFixed(2)} mean word overlap with the real one`);
  console.log(`  project slug right   ${result.projectRight}/${result.projectTotal}  ${pct(result.projectRight, result.projectTotal)}`);
  console.log(`  stayed quiet         ${result.quiet}/${negatives.length}  ${pct(result.quiet, negatives.length)}  (on turns with nothing to keep)`);
  console.log(`  failed outright      ${result.failed}`);
  console.log(`  median latency       ${result.latency.sort((a, b) => a - b)[result.latency.length >> 1] ?? 0}ms`);
  console.log('  examples:');
  for (const item of result.items.slice(0, 3)) {
    console.log(`    typed -> ${item.want.slice(0, 68)}`);
    console.log(`    got   -> ${item.got.slice(0, 68)}`);
  }
}
