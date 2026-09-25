#!/usr/bin/env node
// Gathers everything the daily review needs about the consolidation runs in a
// window, and writes it to a dated folder. Reads only.
//
//   node collect.mjs                      since the last review, or 48 hours
//   node collect.mjs --since 2026-09-24T00:00:00+05:30 [--until ...]
//   node collect.mjs --mark <folder>      record that folder's window as reviewed
//
// Two halves that are kept apart on purpose:
//
//   blind/      what the pass was given: the memories in scope at that moment,
//               the projects that exist, and the new turns, whole. Nothing the
//               pass produced. The blind readers see only this folder.
//   pipeline/   what the pass did: the prompt it was actually sent, its raw
//               answer, the changes that landed, the job's own report, and
//               the Langfuse trace (model, thinking, tokens, cost, errors).
//
// The folder holds conversations, so it is created private and stays on this
// machine. Nothing here is committed.
import {mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {sql, lit} from './db.mjs';
import {observations, summarize} from './langfuse.mjs';

const HOME = process.env.HOME;
const ROOT = process.env.SATCHEL_DAILY_DIR ?? join(HOME, 'satchel-daily');
const STATE = join(ROOT, 'state.json');
// The consolidator cuts each turn before the model sees it
// (server/consolidator.mjs, the slice in the turn formatter). Counted here so
// the review can tell a miss the model made from one it was never shown.
const CUT = {user: 2000, assistant: 800};
const BATCH_CHARS = 90_000;

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const asDate = (value, name) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is not a date: ${value}`);
  return date.toISOString();
};
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };

if (flag('--mark')) {
  const window = readJson(join(flag('--mark'), 'window.json'), null);
  if (!window) throw new Error('no window.json in that folder');
  writeFileSync(STATE, JSON.stringify({until: window.until, folder: flag('--mark')}, null, 1));
  console.log(`reviewed through ${window.until}`);
  process.exit(0);
}

const state = readJson(STATE, {});
const until = asDate(flag('--until') ?? new Date(), '--until');
const since = asDate(flag('--since') ?? state.until ?? new Date(Date.now() - 48 * 3600e3), '--since');

mkdirSync(ROOT, {recursive: true, mode: 0o700});
const day = new Date().toLocaleDateString('en-CA');
let out = join(ROOT, day);
for (let n = 2; existsSync(out); n++) out = join(ROOT, `${day}-${n}`);
mkdirSync(join(out, 'blind'), {recursive: true, mode: 0o700});
mkdirSync(join(out, 'pipeline'), {recursive: true, mode: 0o700});
chmodSync(out, 0o700);
const write = (path, text) => writeFileSync(join(out, path), text, {mode: 0o600});

const jobs = await sql(`select * from public.consolidation_jobs
  where started_at >= ${lit(since)} and started_at < ${lit(until)} order by started_at`);
const runs = await sql(`select r.id, r.owner_id, r.document_id, r.trace_id, r.model, r.through, r.error,
    r.added, r.extended, r.replaced, r.retired, r.affirmed, r.dropped, r.duration_ms, r.created_at,
    r.prompt, r.response, d.session_key, d.project_id, d.turns doc_turns, p.slug
  from public.consolidation_runs r
  left join public.documents d on d.id = r.document_id
  left join public.projects p on p.id = d.project_id
  where r.created_at >= ${lit(since)} and r.created_at < ${lit(until)}
  order by r.created_at`);

const owners = [...new Set([...jobs.map(j => j.owner_id), ...runs.map(r => r.owner_id)])];
write('window.json', JSON.stringify({since, until, jobs: jobs.length, runs: runs.length, owners: owners.length}, null, 1));
if (!runs.length) {
  // The short report still needs the queue, and a review that ran twice in a
  // day lands here every time.
  const [{n}] = await sql(`select count(*)::int n from public.documents
    where consolidated_at is null or last_turn_at > consolidated_at`);
  write('stats.json', JSON.stringify({jobs: [], waiting_now: n}, null, 1));
  console.log(`nothing ran between ${since} and ${until}. ${n} sessions waiting now. Folder: ${out}`);
  process.exit(0);
}

const projectsOf = {};
const reposOf = {};
for (const owner of owners) {
  projectsOf[owner] = await sql(`select id, slug, name, brief from public.projects where owner_id = ${lit(owner)} order by slug`);
  reposOf[owner] = await sql(`select project_id, repository from public.project_repositories where owner_id = ${lit(owner)}`);
}
const slugOf = owner => Object.fromEntries(projectsOf[owner].map(p => [p.id, p.slug]));

/** The memory set as it stood just before a run: rows that existed and were
 *  live then, worded as they were then. A later change's `before` is the
 *  wording the run saw. */
const setAt = (owner, at) => sql(`select m.id, m.project_id, m.kind, m.band, m.mentions,
    coalesce((select e.before from public.memory_events e
              where e.memory_id = m.id and e.created_at >= ${lit(at)} and e.before is not null
              order by e.created_at limit 1), m.statement) statement
  from public.memories m
  where m.owner_id = ${lit(owner)} and m.created_at < ${lit(at)}
    and (m.ended_at is null or m.ended_at >= ${lit(at)})
    and (m.expires_at is null or m.expires_at > ${lit(at)})
  order by m.project_id nulls first, m.mentions desc`);

const jobRunFor = run => {
  for (const job of jobs) for (const entry of job.runs ?? [])
    if (entry.document === run.document_id || (entry.session_key && entry.session_key === run.session_key)) return {job: job.id, entry};
  return null;
};

// Langfuse is a second witness, not a dependency: if it cannot be reached the
// review still runs, and says so.
let traces = {};
let langfuseError = null;
try {
  const pad = ms => new Date(Date.parse(since) + ms).toISOString();
  traces = summarize(await observations(pad(-60e3), until), runs.map(r => r.trace_id).filter(Boolean));
} catch (error) { langfuseError = error.message; }
write('langfuse.json', JSON.stringify({error: langfuseError, traces}, null, 1));

const seen = {};
for (const run of runs) {
  const short = String(run.document_id ?? run.id).slice(0, 8);
  seen[short] = (seen[short] ?? 0) + 1;
  run.name = seen[short] > 1 ? `${short}-${seen[short]}` : short;
}

/** A few at a time, so a big night does not take ten minutes of round trips. */
async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i]); }
  }));
  return results;
}

const index = (await pool(runs, 4, async run => {
  const name = run.name;
  const scope = run.slug ?? 'personal';
  const slugs = slugOf(run.owner_id);

  // What landed, matched on the trace the pass wrote with.
  const events = run.trace_id ? await sql(`select e.memory_id, e.action, e.before, e.after, e.reason,
      e.actor, m.kind, m.project_id, m.band
    from public.memory_events e left join public.memories m on m.id = e.memory_id
    where e.trace_id = ${lit(run.trace_id)} order by e.created_at`) : [];
  const job = jobRunFor(run);
  write(`pipeline/${name}.md`, [
    `# ${name} · scope ${scope} · ${run.created_at}`, '',
    `model ${run.model} · ${run.duration_ms ?? '?'} ms · error ${run.error ?? 'none'}`,
    `counts: added ${run.added} extended ${run.extended} replaced ${run.replaced} retired ${run.retired} affirmed ${run.affirmed} rejected ${run.dropped}`, '',
    '## What landed (memory_events on this trace)', '',
    ...(events.length ? events.map(e => `- ${e.action} [${e.kind ?? '?'} · ${e.project_id ? slugs[e.project_id] ?? e.project_id : 'personal'} · ${e.band ?? '?'}] ${e.after ?? e.before ?? ''}${e.reason ? `  (reason: ${e.reason})` : ''}`) : ['- nothing']), '',
    '## The job report entry', '',
    job ? '```json\n' + JSON.stringify(job.entry, null, 1) + '\n```' : 'not part of a job in this window', '',
    '## Langfuse', '',
    langfuseError ? `unavailable: ${langfuseError}` : traces[run.trace_id]
      ? '```json\n' + JSON.stringify(traces[run.trace_id], null, 1) + '\n```' : 'no trace found for this run', '',
    '## Raw model answer', '',
    '```\n' + String(run.response ?? '(none)').slice(0, 20_000) + '\n```', '',
  ].join('\n'));
  write(`pipeline/${name}.prompt.txt`, String(run.prompt ?? '(no prompt stored)'));

  if (run.through == null || run.error) return {name, scope, error: run.error ?? 'no through mark', turns: 0, chars: 0};
  const [prev] = await sql(`select max(through) m from public.consolidation_runs
    where document_id = ${lit(run.document_id)} and created_at < ${lit(run.created_at)} and through is not null and error is null`);
  const after = prev?.m ?? 0;
  const turns = await sql(`select id, role, content, created_at from public.document_turns
    where document_id = ${lit(run.document_id)} and id > ${Number(after)} and id <= ${Number(run.through)} order by id`);
  const memories = await setAt(run.owner_id, run.created_at);
  const inScope = memories.filter(m => m.project_id === null || m.project_id === run.project_id);
  const cut = turns.filter(t => t.content.length > (CUT[t.role] ?? Infinity));
  const repos = reposOf[run.owner_id];
  write(`blind/${name}.md`, [
    `# Session ${name} · scope: ${scope}`, '',
    '## Projects that exist', '',
    ...projectsOf[run.owner_id].map(p => `- ${p.slug}: ${p.brief ?? p.name ?? ''}`.slice(0, 220)
      + (repos.some(r => r.project_id === p.id) ? ` (repos: ${repos.filter(r => r.project_id === p.id).map(r => r.repository).join(', ')})` : '')), '',
    '## Memories that already existed before this pass (personal, plus this session\'s project)', '',
    ...inScope.map((m, i) => `${i + 1}. [${m.kind} · ${m.project_id ? slugs[m.project_id] : 'personal'}${m.mentions > 1 ? ` · said ${m.mentions} times` : ''}] ${m.statement}`), '',
    `## The new turns (${turns.length})`, '',
    ...turns.map(t => `### ${t.role} · ${t.created_at}\n\n${t.content}\n`),
  ].join('\n'));
  return {name, scope, turns: turns.length, chars: turns.reduce((n, t) => n + t.content.length, 0),
    cut_user: cut.filter(t => t.role === 'user').length, cut_assistant: cut.filter(t => t.role === 'assistant').length,
    model: run.model, landed: events.length};
}));

// Batches for the blind readers, biggest first so no batch is all small ones.
const readable = index.filter(s => s.turns > 0).sort((a, b) => b.chars - a.chars);
const batches = [];
for (const s of readable) {
  const open = batches.find(b => b.chars + s.chars <= BATCH_CHARS);
  if (open) { open.files.push(`${s.name}.md`); open.chars += s.chars; }
  else batches.push({files: [`${s.name}.md`], chars: s.chars});
}
write('blind/INDEX.json', JSON.stringify({sessions: index, batches}, null, 1));

// The shape of the whole set, now and in this window.
const stats = {};
for (const owner of owners) {
  stats[owner.slice(0, 8)] = {
    live: await sql(`select coalesce(p.slug, 'personal') scope, m.kind, m.band, count(*)::int n
      from public.memories m left join public.projects p on p.id = m.project_id
      where m.owner_id = ${lit(owner)} and m.ended_at is null and (m.expires_at is null or m.expires_at > now())
      group by 1, 2, 3 order by 1, 2, 3`),
    changed_in_window: await sql(`select e.action, coalesce(p.slug, 'personal') scope, m.kind, count(*)::int n
      from public.memory_events e join public.memories m on m.id = e.memory_id left join public.projects p on p.id = m.project_id
      where e.owner_id = ${lit(owner)} and e.created_at >= ${lit(since)} and e.created_at < ${lit(until)}
      group by 1, 2, 3 order by 1, 2, 3`),
    documents_in_window: await sql(`select coalesce(p.slug, 'personal (no project)') scope, count(*)::int n
      from public.documents d left join public.projects p on p.id = d.project_id
      where d.owner_id = ${lit(owner)} and d.last_turn_at >= ${lit(since)} and d.last_turn_at < ${lit(until)}
      group by 1 order by 2 desc`),
    waiting_now: (await sql(`select count(*)::int n from public.documents
      where owner_id = ${lit(owner)} and (consolidated_at is null or last_turn_at > consolidated_at)`))[0].n,
  };
}
write('stats.json', JSON.stringify({jobs: jobs.map(j => ({id: j.id, status: j.status, stop_reason: j.stop_reason,
  started_at: j.started_at, read: j.read, waiting: j.waiting, added: j.added, extended: j.extended,
  replaced: j.replaced, retired: j.retired, affirmed: j.affirmed, dropped: j.dropped, failed: j.failed})), stats}, null, 1));

console.log(`${runs.length} runs in ${jobs.length} jobs, ${readable.length} sessions to read in ${batches.length} batches`);
console.log(langfuseError ? `langfuse: unavailable (${langfuseError})` : `langfuse: ${Object.keys(traces).length} of ${runs.length} runs matched a trace`);
console.log(`folder: ${out}`);
