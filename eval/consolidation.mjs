#!/usr/bin/env node
// Does the consolidation pass change the memory set correctly.
//
//   GEMINI_API_KEY=... node eval/consolidation.mjs
//   GEMINI_API_KEY=... node eval/consolidation.mjs --prompt local --prompt production
//   GEMINI_API_KEY=... node eval/consolidation.mjs --only retire --repeat 3
//   GEMINI_API_KEY=... node eval/consolidation.mjs --update-baseline
//
// The other two capture evals cannot measure this. eval/router.mjs replays a
// corpus made of memories, so every turn has an answer. router-rigour.mjs
// measures whether a turn contains a claim at all. Both ask one question with
// two answers, insert or nothing, because that is all the router can do.
//
// This asks what the set should look like now, which has five answers and four
// of them name a memory that already exists. A pass that adds the right thing
// while retiring the wrong thing has not done well, and no accuracy number
// over one column would show it.
//
// Three rules this harness follows, all of them learned elsewhere in eval/.
//
// The model is pinned and the fallback is off. createConsolidator will happily
// switch models when one is overloaded, which is right in production and ruins
// a measurement: half the run would be one model and half another, and the
// report would say neither.
//
// Destructive mistakes are counted on their own and the bar is zero. An add
// that should not exist is one row to delete; a memory that was retired stops
// loading until somebody goes and finds it.
//
// And the two halves are printed together. Restraint is won by changing
// nothing and action is won by changing everything.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createConsolidator} from '../server/consolidator.mjs';
import {consolidatePrompt, localTextFor, CONSOLIDATE_PROMPT} from '../server/prompt-store.mjs';
import {score, summarise, isRestraint} from './lib/consolidation-scoring.mjs';

const suite = JSON.parse(readFileSync(new URL('./consolidation-cases.json', import.meta.url), 'utf8'));
const baselineFile = new URL('./consolidation-baseline.json', import.meta.url);
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null;
const wanted = args.reduce((list, arg, i) => arg === '--prompt' ? [...list, args[i + 1]] : list, []);
const VERSIONS = wanted.length ? wanted : ['local'];
const ONLY = flag('only');
const REPEAT = Math.max(1, Number(flag('repeat') ?? 1));

// Pinned here rather than taken from the module default, so a run says which
// model produced its numbers and two runs of different models cannot be
// compared by accident.
const MODEL = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.8-flash';
const THINKING = process.env.SATCHEL_THINKING_LEVEL ?? 'medium';
// The free tier allows 20 requests a day per model on the newest ones, so a
// full run of this bench does not fit on a free key. Paced anyway, because the
// per-minute limit is the one that bites first on the older models.
const PACE_MS = Number(process.env.CONSOLIDATION_EVAL_PACE_MS ?? 1500);
const wait = ms => new Promise(done => setTimeout(done, ms));

async function instructionsFor(version) {
  if (version === 'local') return {text: localTextFor(CONSOLIDATE_PROMPT), source: 'local', version: 'local'};
  if (version === 'production') {
    const live = await consolidatePrompt({ttlMs: 0});
    if (live.source !== 'langfuse')
      throw new Error('asked for the production prompt and Langfuse did not serve one');
    return live;
  }
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST;
  const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');
  const url = new URL(`/api/public/v2/prompts/${CONSOLIDATE_PROMPT}`, baseUrl);
  url.searchParams.set('version', String(version));
  const response = await fetch(url, {headers: {authorization: `Basic ${auth}`}});
  if (!response.ok) throw new Error(`Langfuse answered ${response.status} for version ${version}`);
  const body = await response.json();
  return {text: body.prompt, source: 'langfuse', version: body.version};
}

const bySlug = new Map(suite.projects.map(p => [p.slug, p]));
const cases = suite.cases.filter(c => !ONLY || c.category === ONLY);
// The date every case is read against, fixed so a run in March and a run in
// December score the temporal case the same way.
const NOW = new Date('2026-09-22T09:00:00Z');

/** The case as the pass would see it: numbered memories, both roles, a date. */
function inputFor(item) {
  const working = bySlug.get(item.working) ?? null;
  return {
    now: NOW,
    project: working,
    projects: suite.projects.filter(p => p.slug !== working?.slug),
    memories: (item.memories ?? []).map((m, i) => ({
      id: `m${i + 1}`, statement: m.statement, kind: m.kind,
      project_slug: m.scope ?? null, revision: 1,
      mentions: m.mentions ?? 1, commits_since: m.commits_since ?? null,
      affirmed_at: '2026-09-15T09:00:00Z',
    })),
    turns: (item.turns ?? []).map((t, i) => ({...t, id: i + 1, created_at: '2026-09-22T08:00:00Z'})),
  };
}

/** Targets come back as memory ids; the case talks in numbers, which is also
 *  what the model was shown. Mapping back here keeps the cases readable. */
const asNumber = target => target ? Number(String(target).replace(/^m/, '')) : null;

const report = {};
for (const version of VERSIONS) {
  const instructions = await instructionsFor(version);
  const consolidator = createConsolidator({
    model: MODEL, thinking: THINKING, fallback: null,
    promptResolver: async () => instructions,
    ...(process.env.GEMINI_API_KEY && !process.env.SATCHEL_ROUTER_URL
      ? {apiKey: process.env.GEMINI_API_KEY} : {}),
  });
  console.log(`\nprompt ${instructions.source} ${instructions.version}  ${instructions.text.length} characters`);
  console.log(`model ${MODEL}  thinking ${THINKING}  ·  ${cases.length} cases  ·  ${REPEAT} run(s) each\n`);

  const rows = [];
  const noted = [];
  const wrong = [];
  let failed = 0, dropped = 0;
  for (const item of cases) {
    for (let run = 0; run < REPEAT; run++) {
      let out;
      try {
        out = await consolidator.consolidate(inputFor(item));
      } catch (error) {
        failed++;
        wrong.push({id: item.id, note: `failed: ${(error.reason ?? error.message).slice(0, 70)}`});
        await wait(PACE_MS);
        continue;
      }
      dropped += out.dropped.length;
      const changes = out.changes.map(c => ({...c, target: asNumber(c.target)}));
      const result = score(item, changes);
      rows.push({...result, id: item.id, category: item.category,
        restraint: isRestraint(item.expect)});
      if (!result.scored) noted.push({id: item.id,
        got: changes.length ? changes.map(c => `${c.action}${c.target ? ` #${c.target}` : ''}`).join('+') : 'nothing'});
      else if (!result.ok) wrong.push({id: item.id, note: result.note, turn: item.turns?.[0]?.content});
      for (const bad of result.harm)
        wrong.push({id: item.id, note: `DAMAGE: ${bad.action} on #${bad.target ?? 'none'}`, harm: true});
      await wait(PACE_MS);
    }
  }

  const sum = summarise(rows);
  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
  for (const [category, row] of [...sum.byCategory].sort())
    console.log(`  ${category.padEnd(20)} ${row.right}/${row.total}  ${pct(row.right, row.total)}`);
  console.log(`  ${'-'.repeat(34)}`);
  console.log(`  ${'left it alone'.padEnd(20)} ${sum.restraint.right}/${sum.restraint.total}  ${pct(sum.restraint.right, sum.restraint.total)}   (cases where nothing should change)`);
  console.log(`  ${'changed it right'.padEnd(20)} ${sum.action.right}/${sum.action.total}  ${pct(sum.action.right, sum.action.total)}   (and hit the memory it named)`);
  console.log(`  ${'both'.padEnd(20)} ${sum.both.right}/${sum.both.total}  ${pct(sum.both.right, sum.both.total)}`);
  console.log(`  ${'ended wrongly'.padEnd(20)} ${sum.harm}${sum.harm ? '   <- the bar for this is zero' : '   (nothing was retired or replaced that should not have been)'}`);
  if (dropped) console.log(`  ${'dropped by validate'.padEnd(20)} ${dropped}   (never reached the database; a wording producing these is still wrong)`);
  if (failed) console.log(`  ${'failed outright'.padEnd(20)} ${failed}`);

  if (noted.length) {
    console.log('\n  noted, not scored:');
    for (const n of noted) console.log(`    ${n.id.padEnd(8)} -> ${n.got}`);
  }
  if (wrong.length) {
    console.log('\n  wrong:');
    for (const w of wrong) {
      console.log(`    ${w.id.padEnd(8)} ${w.note}`);
      if (w.turn) console.log(`             turn: ${w.turn.slice(0, 84)}`);
    }
  }
  report[version] = {
    model: MODEL, thinking: THINKING, prompt: String(instructions.version), repeat: REPEAT,
    restraint: sum.restraint, action: sum.action, both: sum.both, harm: sum.harm, dropped, failed,
  };
}

// The baseline is the local prompt, because that is the one a change edits.
const current = report.local;
if (args.includes('--update-baseline') && current) {
  writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n');
  console.log('\nbaseline updated');
} else if (current && existsSync(baselineFile)) {
  const before = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const rate = r => r.total ? r.right / r.total : 0;
  const moved = rate(current.both) - rate(before.both);
  console.log(`\nbaseline ${before.model} thinking ${before.thinking}: `
    + `both ${before.both.right}/${before.both.total}, ended wrongly ${before.harm}`);
  console.log(`now      ${current.model} thinking ${current.thinking}: `
    + `both ${current.both.right}/${current.both.total}, ended wrongly ${current.harm}  (${moved >= 0 ? '+' : ''}${(moved * 100).toFixed(0)} points)`);
  // A model call is not deterministic even at temperature zero, so a small
  // move is noise and gating on it would make the bench something people
  // rerun until it passes. Ending a memory that should not have ended is not
  // noise: one is a regression.
  if (current.harm > before.harm) {
    console.error('\nREGRESSION: more memories ended that should not have been.');
    process.exit(1);
  }
  if (moved < -0.08) {
    console.error('\nREGRESSION: more than 8 points worse overall.');
    process.exit(1);
  }
}
