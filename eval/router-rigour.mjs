#!/usr/bin/env node
// Does the router keep the right things, and only those.
//
//   GEMINI_API_KEY=... node eval/router-rigour.mjs                  # the local prompt
//   GEMINI_API_KEY=... node eval/router-rigour.mjs --prompt 1       # a Langfuse version
//   GEMINI_API_KEY=... node eval/router-rigour.mjs --prompt 1 --prompt local   # both, side by side
//
// eval/router.mjs measures capture against the invented corpus: does a claim
// survive being replayed, and does it land in the right scope. It cannot
// measure this, because the corpus contains memories and this is about the
// turns that only look like memories.
//
// So the cases here are real. Most of them were copied out of Langfuse after
// the router stored a work order as a durable claim, and each one names the
// observation it came from. The rest are written to sit next to those, so a
// wording that only handles the exact sentence that failed does not score.
//
// The two halves must be read together. Staying quiet is trivial to win by
// being silent, so the durable cases are the other side of the same number.
import {readFileSync} from 'node:fs';
import {createRouter} from '../server/router.mjs';
import {capturePrompt, localText} from '../server/prompt-store.mjs';

const suite = JSON.parse(readFileSync(new URL('./router-cases.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const wanted = args.reduce((list, arg, i) =>
  arg === '--prompt' ? [...list, args[i + 1]] : list, []);
const VERSIONS = wanted.length ? wanted : ['local'];
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const GEMINI = process.env.GEMINI_API_KEY && !process.env.SATCHEL_ROUTER_URL;
const ROUTER_CONFIG = GEMINI ? {apiKey: process.env.GEMINI_API_KEY} : {};
// Same reason as the other eval: the free tier allows 15 requests a minute and
// a run that spends half its calls learning that measures nothing.
const PACE_MS = Number(process.env.ROUTER_EVAL_PACE_MS ?? (GEMINI ? 4300 : 3200));
const MODEL = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.5-flash-lite';

/** One wording, resolved once, so a run cannot straddle two of them. */
async function instructionsFor(version) {
  if (version === 'local') return {text: localText, source: 'local', version: 'local'};
  if (version === 'production') {
    const live = await capturePrompt({ttlMs: 0});
    if (live.source !== 'langfuse')
      throw new Error('asked for the production prompt and Langfuse did not serve one');
    return live;
  }
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST;
  const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');
  const url = new URL('/api/public/v2/prompts/satchel-capture-router', baseUrl);
  url.searchParams.set('version', String(version));
  const response = await fetch(url, {headers: {authorization: `Basic ${auth}`}});
  if (!response.ok) throw new Error(`Langfuse answered ${response.status} for version ${version}`);
  const body = await response.json();
  return {text: body.prompt, source: 'langfuse', version: body.version};
}

// Containment, not similarity, and not the symmetric overlap the other eval
// uses. The question here is only "is the claim in what came back", and the
// symmetric version failed a correct answer for being longer than the wanted
// one: "Do not use em dashes anywhere" against "No em dashes" scored 0.33.
// Dividing by the shorter side asks the question actually being asked.
function contains(got, want) {
  const words = t => new Set(String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const x = words(got), y = words(want);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

const wait = ms => new Promise(done => setTimeout(done, ms));
const cases = suite.cases.filter(c => !ONLY || c.category === ONLY);
const projects = suite.projects;
const bySlug = new Map(projects.map(p => [p.slug, p]));

for (const version of VERSIONS) {
  const instructions = await instructionsFor(version);
  const router = createRouter({model: MODEL, ...ROUTER_CONFIG, promptResolver: async () => instructions});
  console.log(`\nprompt ${instructions.source} ${instructions.version}  ${instructions.text.length} characters  ·  model ${MODEL}`);

  const tally = new Map();
  const wrong = [];
  const noted = [];
  let failed = 0;
  for (const item of cases) {
    const working = bySlug.get(item.working) ?? null;
    let out;
    try {
      out = await router.route({
        codebase: working ? `acme/${working.slug}` : null,
        project: working,
        projects: projects.filter(p => p.slug !== working?.slug),
        tasks: suite.tasks, context: [], saved: [], turn: item.turn,
      });
    } catch (error) {
      failed++;
      wrong.push({id: item.id, note: `failed: ${error.message.slice(0, 60)}`});
      await wait(PACE_MS);
      continue;
    }
    const kept = out.memories;
    // A case the corpus records without taking a side. There are turns where
    // both answers are defensible and a bench that pretends otherwise just
    // moves the argument into the scoring. They are printed, not counted.
    if (item.expect === 'either') {
      noted.push({id: item.id, got: kept.length ? kept[0].statement.slice(0, 70) : 'nothing'});
      await wait(PACE_MS);
      continue;
    }
    let ok, note = '';
    if (item.expect === 'nothing') {
      ok = kept.length === 0;
      if (!ok) note = `kept "${kept[0].statement.slice(0, 64)}"`;
    } else {
      // Three ways to be wrong about a claim that should survive: not keeping
      // it, keeping it in the wrong scope, or keeping the part the user was
      // arguing against. The third is the one that made this file exist.
      const forbidden = (item.forbid ?? []).find(bad =>
        kept.some(m => m.statement.toLowerCase().includes(bad.toLowerCase())));
      const best = Math.max(0, ...kept.map(m => contains(m.statement, item.want)));
      const scope = kept.some(m => (m.project ?? null) === (item.wantProject ?? null));
      ok = kept.length > 0 && !forbidden && best >= 0.5 && scope;
      if (!kept.length) note = 'kept nothing';
      else if (forbidden) note = `kept the rejected premise: "${forbidden}"`;
      else if (best < 0.5) note = `drifted: "${kept[0].statement.slice(0, 64)}"`;
      else if (!scope) note = `scope ${kept[0].project ?? 'null'}, wanted ${item.wantProject ?? 'null'}`;
    }
    const row = tally.get(item.category) ?? {right: 0, total: 0};
    row.total++; if (ok) row.right++;
    tally.set(item.category, row);
    if (!ok) wrong.push({id: item.id, note, turn: item.turn[0]});
    await wait(PACE_MS);
  }

  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
  const QUIET = new Set(['work-order', 'rejected-premise', 'question', 'continuation']);
  let quietRight = 0, quietTotal = 0, keepRight = 0, keepTotal = 0;
  console.log('');
  for (const [category, row] of tally) {
    console.log(`  ${category.padEnd(18)} ${row.right}/${row.total}  ${pct(row.right, row.total)}`);
    if (QUIET.has(category)) { quietRight += row.right; quietTotal += row.total; }
    else { keepRight += row.right; keepTotal += row.total; }
  }
  console.log(`  ${'-'.repeat(30)}`);
  console.log(`  ${'stayed quiet'.padEnd(18)} ${quietRight}/${quietTotal}  ${pct(quietRight, quietTotal)}   (turns with nothing durable in them)`);
  console.log(`  ${'kept the claim'.padEnd(18)} ${keepRight}/${keepTotal}  ${pct(keepRight, keepTotal)}   (and put it in the right scope)`);
  console.log(`  ${'both'.padEnd(18)} ${quietRight + keepRight}/${quietTotal + keepTotal}  ${pct(quietRight + keepRight, quietTotal + keepTotal)}`);
  if (failed) console.log(`  ${'failed outright'.padEnd(18)} ${failed}`);
  if (noted.length) {
    console.log('\n  noted, not scored:');
    for (const n of noted) console.log(`    ${n.id}  -> ${n.got}`);
  }
  if (wrong.length) {
    console.log('\n  wrong:');
    for (const w of wrong) {
      console.log(`    ${w.id}  ${w.note}`);
      if (w.turn) console.log(`        turn: ${w.turn.slice(0, 90)}`);
    }
  }
}
