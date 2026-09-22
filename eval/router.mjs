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
import {corpus} from './lib/data.mjs';
import {createRouter} from '../server/router.mjs';
import {mean} from './lib/metrics.mjs';

const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ['qwen/qwen3.8-27b:free'];
// Provider comes from the environment so the same eval compares hosts.
const GEMINI = process.env.GEMINI_API_KEY && !process.env.SATCHEL_ROUTER_URL;
const ROUTER_CONFIG = GEMINI
  ? {apiKey: process.env.GEMINI_API_KEY,
     url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'}
  : {};
// 900ms was 66 calls a minute against a free tier that allows 15, so a run
// spent almost half its calls learning that. The failures were surfaced rather
// than swallowed, which is the only reason it was obvious, but a default that
// is wrong by four times is a default that makes every run useless. Measured
// off the 429 body: "a rate limit was hit (15 requests)".
const PACE_MS = Number(process.env.ROUTER_EVAL_PACE_MS ?? (GEMINI ? 4300 : 3200));
// Two kinds of positive, sampled deliberately rather than in whatever
// proportion they happen to occur.
//
// The router now defaults a memory to the project the conversation is in, which
// is the fix for a deployment detail about this project landing in personal.
// The thing that can regress is the opposite error: a universal preference
// ("never use em dashes") swallowed into whichever project happened to be open.
// Those are 19% of the corpus, so a proportional sample gave four or five of
// them out of 24, which cannot measure a threshold. They get their own count.
const SCOPED = 20;
const PERSONAL = 20;
const NEGATIVES = 16;

const projects = corpus.projects.map(p => ({slug: p.slug, brief: p.brief}));
const bySlug = new Map(projects.map(p => [p.slug, p]));

// A deterministic spread rather than a random one, so two runs compare.
const pick = (list, n) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0).slice(0, n);
const eligible = corpus.memories.filter(m => m.source?.trim().length > 25);
// Each turn is replayed as if the user were working in one project, because
// that is what production now does: the workspace's git remote resolves to a
// project and the router is told which one.
//
// A scoped memory is replayed inside its own project, where the right answer is
// that project. A personal one is replayed inside a project too, rotated so no
// single project's brief can explain the result, and the right answer is still
// null. That second group is the whole measurement: defaulting to the open
// project is only an improvement if a universal preference still comes back
// null from inside one.
const positives = [
  ...pick(eligible.filter(m => m.project), SCOPED)
    .map(m => ({memory: m, working: bySlug.get(m.project) ?? null, want: m.project})),
  ...pick(eligible.filter(m => !m.project), PERSONAL)
    .map((m, i) => ({memory: m, working: projects[i % projects.length], want: null})),
];

// Negatives have to be turns that genuinely contain nothing durable, which is
// not the same as prompts that retrieve nothing. "learn to swim properly"
// retrieves nothing and is still a real intent worth keeping, so using the
// retrieval-answerless set as negatives punished the router for being right.
// These three categories are memory-free by construction: a continuation with
// no topic, a general-knowledge question, and a sentence that only shares
// vocabulary with a memory.
const MEMORY_FREE = new Set(['continuation', 'general-knowledge', 'lexical-trap']);
const negatives = pick(corpus.prompts.filter(p => MEMORY_FREE.has(p.category)), NEGATIVES);

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
  const router = createRouter({model, ...ROUTER_CONFIG});
  const result = {extracted: 0, faithful: [], scopedRight: 0, scopedTotal: 0,
    personalRight: 0, personalTotal: 0, leaked: [],
    quiet: 0, noisy: 0, failed: 0, items: [], latency: [], errors: []};
  console.log(`\n${model}${process.env.ROUTER_EVAL_NO_SCOPE === '1' ? '  (scope withheld: the shape before this change)' : ''}`);

  // The same shape the Stop handler builds: one project named as the scope, the
  // rest offered only for when the user names one.
  //
  // ROUTER_EVAL_NO_SCOPE=1 withholds the scope and hands over a flat list of
  // every project instead, which is what the router was given before. It is the
  // counterfactual for the change, on the same sample and through the same
  // code: extraction and quiet numbers cannot be compared against an older run
  // on a different corpus, but they can be compared against this.
  const blind = process.env.ROUTER_EVAL_NO_SCOPE === '1';
  const asked = working => blind
    ? {codebase: null, project: null, projects, context: [], saved: []}
    : {
      codebase: working ? `acme/${working.slug}` : null,
      project: working,
      projects: projects.filter(p => p.slug !== working?.slug),
      context: [], saved: [],
    };

  for (const {memory, working, want} of positives) {
    const turn = [memory.source];
    const started = Date.now();
    try {
      const out = await router.route({...asked(working), turn});
      result.latency.push(Date.now() - started);
      if (out.memories.length) {
        result.extracted++;
        const best = out.memories.map(m => overlap(m.statement, memory.statement))
          .sort((a, b) => b - a)[0];
        result.faithful.push(best);
        const got = out.memories[0].project ?? null;
        if (want) {
          result.scopedTotal++;
          if (out.memories.some(m => m.project === want)) result.scopedRight++;
        } else {
          result.personalTotal++;
          if (got === null) result.personalRight++;
          // Named, not just counted. A preference swallowed into the open
          // project is the regression this change could cause, and the
          // statement is what tells you whether the model had a point.
          else result.leaked.push({statement: memory.statement.slice(0, 70), into: got, working: working?.slug});
        }
        result.items.push({got: out.memories[0].statement, want: memory.statement, dropped: out.dropped.length});
      }
    } catch (error) { result.failed++; result.errors.push(error.message); }
    await wait(PACE_MS);
  }

  for (const prompt of negatives) {
    // A negative is replayed inside a project too, because a turn with nothing
    // durable in it is the common case and an open project must not make the
    // router start finding things in it.
    try {
      const out = await router.route({...asked(projects[0]), turn: [prompt.text]});
      if (out.memories.length) result.noisy++; else result.quiet++;
    } catch (error) { result.failed++; result.errors.push(error.message); }
    await wait(PACE_MS);
  }

  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
  console.log(`  extracted a memory   ${result.extracted}/${positives.length}  ${pct(result.extracted, positives.length)}`);
  console.log(`  statement overlap    ${mean(result.faithful).toFixed(2)} mean word overlap with the real one`);
  console.log(`  scope, in a project  ${result.scopedRight}/${result.scopedTotal}  ${pct(result.scopedRight, result.scopedTotal)}  (used the project it was working in)`);
  console.log(`  scope, universal     ${result.personalRight}/${result.personalTotal}  ${pct(result.personalRight, result.personalTotal)}  (kept a preference out of the open project)`);
  for (const leak of result.leaked.slice(0, 5))
    console.log(`    leaked into ${leak.into}: ${leak.statement}`);
  console.log(`  stayed quiet         ${result.quiet}/${negatives.length}  ${pct(result.quiet, negatives.length)}  (on turns with nothing to keep)`);
  console.log(`  failed outright      ${result.failed}`);
  if (result.errors.length) {
    const tally = {};
    for (const e of result.errors) tally[e] = (tally[e] ?? 0) + 1;
    for (const [why, n] of Object.entries(tally).sort((a, b) => b[1] - a[1]))
      console.log(`      ${n}x ${why.slice(0, 80)}`);
  }
  console.log(`  median latency       ${result.latency.sort((a, b) => a - b)[result.latency.length >> 1] ?? 0}ms`);
  console.log('  examples:');
  for (const item of result.items.slice(0, 3)) {
    console.log(`    typed -> ${item.want.slice(0, 68)}`);
    console.log(`    got   -> ${item.got.slice(0, 68)}`);
  }
}
