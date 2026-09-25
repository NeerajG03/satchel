#!/usr/bin/env node
// Replays a reviewed window through two versions of the pass, with the same
// inputs, so a TODO can be checked before it ships. Only when a person asks:
// it spends model quota, two calls per session.
//
//   node replay.mjs <folder> --new <checkout with the change> [--old origin/main] [--only 116d8a53,2efbd18e]
//
// Each side runs its own consolidateDocument, so a change to how the input is
// built (scope, memories shown, the header) is measured, not only a change to
// the prompt file. Both sides read their own server/prompts/consolidate.md,
// never Langfuse. The database is read as it stood at each run; every write
// the pass asks for is recorded here and never sent. Output goes to
// <folder>/replay/, which is private like the rest of the folder.
import {readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, mkdtempSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execSync} from 'node:child_process';
import {sql, lit} from './db.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const folder = args[0];
const NEW = flag('--new');
const OLD_REF = flag('--old') ?? 'origin/main';
const ONLY = flag('--only')?.split(',') ?? null;
if (!folder || !NEW) throw new Error('usage: replay.mjs <folder> --new <checkout> [--old <ref>] [--only ids]');
const {since, until} = JSON.parse(readFileSync(join(folder, 'window.json'), 'utf8'));

// Only the model key, read without printing it.
for (const line of readFileSync(`${process.env.HOME}/.config/env`, 'utf8').split('\n')) {
  const m = line.replace(/^export\s+/, '').trim().match(/^GEMINI_API_KEY=(.*)$/);
  if (m) process.env.GEMINI_API_KEY = m[1].replace(/^['"]|['"]$/g, '');
}

// The old side is an archive of the ref, borrowing the new side's packages.
const OLD = mkdtempSync(join(tmpdir(), 'satchel-replay-'));
execSync(`git -C ${JSON.stringify(NEW)} archive ${OLD_REF} | tar -x -C ${JSON.stringify(OLD)}`);
symlinkSync(join(NEW, 'node_modules'), join(OLD, 'node_modules'));
const cleanup = () => { rmSync(join(OLD, 'node_modules')); rmSync(OLD, {recursive: true, force: true}); };

const sides = {};
for (const [name, dir] of [['old', OLD], ['new', NEW]]) {
  const {createConsolidator} = await import(join(dir, 'server/consolidator.mjs'));
  const {consolidateDocument} = await import(join(dir, 'server/consolidation.mjs'));
  const text = readFileSync(join(dir, 'server/prompts/consolidate.md'), 'utf8').trim();
  sides[name] = {consolidateDocument, consolidator: createConsolidator({model: 'gemini-3.8-flash',
    thinking: 'medium', fallback: null, retryAfterMs: 60_000,
    promptResolver: async () => ({text, source: 'local', version: name})})};
}

const runs = (await sql(`select r.id, r.owner_id, r.document_id, r.through, r.created_at, d.project_id, d.session_key, d.turns
  from public.consolidation_runs r join public.documents d on d.id = r.document_id
  where r.created_at >= ${lit(since)} and r.created_at < ${lit(until)} and r.error is null and r.through is not null
  order by r.created_at`)).filter(r => !ONLY || ONLY.includes(String(r.document_id).slice(0, 8)));

const projectsOf = {};
async function projects(owner) {
  return projectsOf[owner] ??= await sql(`select p.id, p.slug, p.name, p.brief,
    coalesce((select json_agg(json_build_object('provider', r.provider, 'repository', r.repository))
      from public.project_repositories r where r.project_id = p.id), '[]'::json) project_repositories
    from public.projects p where p.owner_id = ${lit(owner)} order by p.name`);
}

/** The service as it stood at `at`, read only. Writes are recorded. */
function serviceAt(run, list, writes) {
  const slugOf = Object.fromEntries(list.map(p => [p.id, p.slug]));
  return {
    documentTurns: (id, after) => sql(`select id, role, content, created_at from public.document_turns
      where document_id = ${lit(id)} and id > ${Number(after ?? 0)} and id <= ${Number(run.through)} order by id`),
    memoriesInScope: async projectId => (await sql(`select m.id, m.project_id, m.kind, m.mentions, m.revision,
        m.affirmed_at, m.updated_at,
        coalesce((select e.before from public.memory_events e where e.memory_id = m.id
          and e.created_at >= ${lit(run.created_at)} and e.before is not null order by e.created_at limit 1), m.statement) statement
      from public.memories m where m.owner_id = ${lit(run.owner_id)} and m.created_at < ${lit(run.created_at)}
        and (m.ended_at is null or m.ended_at >= ${lit(run.created_at)})
        and (m.expires_at is null or m.expires_at > ${lit(run.created_at)})
        and (m.project_id is null or m.project_id = ${lit(projectId)})
      order by m.project_id nulls first, m.updated_at desc limit 60`))
      .map(m => ({...m, project_slug: m.project_id ? slugOf[m.project_id] : null, commits_since: null})),
    captureMemory: async a => { writes.push({write: 'add', project: a.project, kind: a.kind, statement: a.statement}); return {id: `new${writes.length}`}; },
    extendMemory: async a => { writes.push({write: 'extend', target: a.id, statement: a.statement}); return {id: a.id}; },
    affirmMemory: async id => { writes.push({write: 'affirm', target: id}); return {id}; },
    endMemory: async a => { writes.push({write: `end ${a.reason}`, target: a.id}); return {id: a.id}; },
    markDocumentConsolidated: async () => {},
    logConsolidationRun: async entry => { if (entry.error) writes.push({write: 'error', error: String(entry.error).slice(0, 200)}); },
  };
}

mkdirSync(join(folder, 'replay'), {recursive: true, mode: 0o700});
const outFile = join(folder, 'replay', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
const results = [];
try {
  for (const run of runs) {
    const [prev] = await sql(`select max(through) m from public.consolidation_runs where document_id = ${lit(run.document_id)}
      and created_at < ${lit(run.created_at)} and through is not null and error is null`);
    const list = await projects(run.owner_id);
    const document = {id: run.document_id, session_key: run.session_key, project_id: run.project_id,
      turns: run.turns, consolidated_through: prev?.m ?? null};
    const row = {document: String(run.document_id).slice(0, 8), scope: list.find(p => p.id === run.project_id)?.slug ?? 'personal'};
    for (const name of ['old', 'new']) {
      const writes = [];
      try {
        await sides[name].consolidateDocument(serviceAt(run, list, writes), sides[name].consolidator, document,
          {projects: list, ownerId: run.owner_id});
      } catch (error) { writes.push({write: 'error', error: String(error.message).slice(0, 200)}); }
      row[name] = writes;
      await new Promise(r => setTimeout(r, 1500));
    }
    results.push(row);
    const n = w => w.some(x => x.write === 'error') ? 'ERR' : w.length;
    console.log(`${row.document} ${row.scope} old ${n(row.old)} new ${n(row.new)}`);
    writeFileSync(outFile, JSON.stringify(results, null, 1), {mode: 0o600});
  }
} finally { cleanup(); }

const count = (name, f) => results.flatMap(r => r[name].filter(w => w.write !== 'error').map(w => ({...w, scope: r.scope}))).filter(f).length;
console.log(`\n${results.length} sessions · ${outFile}`);
console.log('                          old  new');
for (const [label, f] of [['changes', () => true], ['project-scoped', w => w.project],
  ['unlinked into a project', w => w.project && w.scope === 'personal'], ['extend / affirm', w => w.write === 'extend' || w.write === 'affirm'],
  ['errors', null]])
  console.log(`  ${label.padEnd(24)}${String(f ? count('old', f) : results.filter(r => r.old.some(w => w.write === 'error')).length).padStart(4)} ${String(f ? count('new', f) : results.filter(r => r.new.some(w => w.write === 'error')).length).padStart(4)}`);
