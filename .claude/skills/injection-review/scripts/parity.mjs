#!/usr/bin/env node
// Does the twin in eval/lib/injection-twin.mjs still rank the way the
// database does. Run it before trusting a replay.
//
//   node parity.mjs [--count 40] [--checkout <dir>]
//
// The same recent queries go through both: search_memories in production,
// called read only through the management API, and the twin, against the
// snapshot. Same arguments either side (the session's topic, the settings,
// the personal rows session start loads excluded), so any difference is the
// ranking itself. Same ids in the same order, with the same matched and in
// scope counts, is a match.
//
// Replaying old log rows does not work as a check, and it was tried first:
// the pass extends and corrects memories every night, which re-embeds them,
// so a row from last week was ranked against vectors that no longer exist.
// That measured the memory set moving, at about 55%, not the twin.
//
// So the snapshot has to be current. If any memory changed after it was taken
// the check refuses and says to collect again, rather than blaming the twin
// for the data.
//
// Under 100% means the twin has drifted from the SQL, and every replay number
// is suspect until it is fixed. Float rounding can, very rarely, swap two
// memories whose scores tie to the sixth decimal; that is the only accepted
// difference and the report names it.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {sql, lit} from '../../daily-improvement/scripts/db.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DAYS = Number(flag('--days') ?? 7);
const CHECKOUT = flag('--checkout') ?? join(import.meta.dirname, '../../../..');
const DIR = process.env.SATCHEL_INJECTION_EVAL_DIR ?? join(process.env.HOME, 'satchel-daily', 'injection-eval');
const COUNT = Number(flag('--count') ?? 40);

const {search, personal} = await import(join(CHECKOUT, 'eval/lib/injection-twin.mjs'));
const {personalLoad} = await import(join(CHECKOUT, 'server/injection-format.mjs'));
const {promptKey: hash, fill} = await import(join(CHECKOUT, 'eval/lib/injection-cache.mjs'));
const snapshot = JSON.parse(readFileSync(join(DIR, 'snapshot.json'), 'utf8'));
const vectors = JSON.parse(readFileSync(join(DIR, 'vectors', 'memories.json'), 'utf8'));
const cachePath = join(DIR, 'vectors', 'prompts.json');
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

const [{changed}] = await sql(`select max(greatest(updated_at, coalesce(ended_at, updated_at), coalesce(embedded_at, updated_at))) as changed
  from public.memories where owner_id = ${lit(snapshot.owner)}`);
// A memory deleted outright, or a settings row that changed, leaves no
// timestamp behind, so the live set and the settings are compared as well.
const [{ids: liveNow}] = await sql(`select coalesce(array_agg(id order by id), '{}') as ids from public.memories
  where owner_id = ${lit(snapshot.owner)} and ended_at is null`);
const liveThen = snapshot.memories.filter(m => !m.ended_at).map(m => m.id).sort();
const settingsNow = (await sql(`select per_prompt_matches, gate, scope_boost, block_size from public.memory_settings
  where owner_id = ${lit(snapshot.owner)} limit 1`))[0];
const settingsMoved = settingsNow && ['per_prompt_matches', 'gate', 'scope_boost', 'block_size']
  .some(k => Number(settingsNow[k]) !== Number(snapshot.settings[k]));
if (liveNow.join() !== liveThen.join() || settingsMoved) {
  console.log('the live memories or the settings differ from the snapshot; run collect-injections.mjs again first');
  process.exit(1);
}
if (changed && new Date(changed) > new Date(snapshot.taken_at)) {
  console.log(`a memory changed at ${changed}, after the snapshot (${snapshot.taken_at}); run collect-injections.mjs again first`);
  process.exit(1);
}

const rows = await sql(`select distinct on (i.query) i.query, s.topic_id, i.created_at
  from public.memory_injections i
  left join public.agent_session_scopes s on s.session_key = i.session_key and s.owner_id = i.owner_id
  where i.owner_id = ${lit(snapshot.owner)} and i.event = 'UserPromptSubmit' and i.query is not null
  order by i.query, i.created_at desc`);
const sample = rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, COUNT);

if (await fill(cache, sample.map(r => r.query))) writeFileSync(cachePath, JSON.stringify(cache));

const settings = snapshot.settings;
const load = personalLoad(personal(snapshot.memories, snapshot.taken_at), settings.block_size);
const exclude = [...load.said, ...load.heard].map(m => m.id);
const uuidArray = ids => `array[${ids.map(lit).join(',')}]::uuid[]`;
let same = 0, ties = 0;
const misses = [];
for (const row of sample) {
  const vector = cache[hash(row.query)];
  // Both sides: each with this session's topic, and once more unscoped, so
  // the boost is exercised and so is its absence.
  for (const topic of [...new Set([row.topic_id ?? null, null])]) {
    const want = await sql(`select id, score, matched, in_scope from public.search_memories(
      ${lit(`[${vector.join(',')}]`)}::extensions.vector, ${topic ? `${lit(topic)}::uuid` : 'null'},
      ${Number(settings.per_prompt_matches)}, ${Number(settings.gate)}::real, ${Number(settings.scope_boost)}::real, ${uuidArray(exclude)})`);
    const got = search(snapshot.memories, vectors, vector, {in_scope: topic, limit: settings.per_prompt_matches,
      gate: settings.gate, boost: settings.scope_boost, exclude, at: snapshot.taken_at});
    const counts = r => r[0] ? `${r[0].matched}/${r[0].in_scope}` : '';
    if (got.map(r => r.id).join() === want.map(r => r.id).join() && counts(got) === counts(want)) { same++; continue; }
    const sorted = r => r.map(x => x.id).sort().join();
    const tie = sorted(got) === sorted(want) && want.some((w, i) => got[i] && Math.abs(w.score - got[i].score) < 1e-6);
    if (tie) { ties++; same++; continue; }
    misses.push({at: String(row.created_at).slice(0, 16), topic: Boolean(topic),
      want: `${want.length} rows ${counts(want)}`, got: `${got.length} rows ${counts(got)}`});
  }
}
const total = same + misses.length;
console.log(`parity: ${sample.length} recent queries, ${total} searches, snapshot ${snapshot.taken_at.slice(0, 16)}`);
console.log(`  same ids, order and counts   ${same} of ${total}${ties ? ` (${ties} differ only by a float tie)` : ''}`);
for (const m of misses.slice(0, 8))
  console.log(`  differs, query from ${m.at}${m.topic ? ', scoped' : ''}: production ${m.want}, twin ${m.got}`);
console.log(misses.length ? '  the twin has drifted from search_memories: fix it before reading any replay'
  : '  the twin matches; replay numbers can be trusted');
if (misses.length) process.exitCode = 1;
