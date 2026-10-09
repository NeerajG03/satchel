#!/usr/bin/env node
// How the topics are doing, for step 5's topic questions. Reads only.
//
//   node topics.mjs <folder>
//
// Writes <folder>/topics.md and topics.json: every topic with what hangs off
// it, what the window made, moved and merged, what sits in personal now, and
// two signals a person would otherwise have to go looking for: topics Satchel
// made that never filled up, and pairs of topics whose names overlap. The
// signals are for the reviewer to judge, not verdicts.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql, lit} from './db.mjs';

const folder = process.argv[2];
if (!folder) throw new Error('usage: topics.mjs <folder>');
const {since, until} = JSON.parse(readFileSync(join(folder, 'window.json'), 'utf8'));
const inWindow = column => `${column} > ${lit(since)} and ${column} <= ${lit(until)}`;

const topics = await sql(`select t.slug, t.made_by, t.created_at, t.merged_into is not null merged,
    (select count(*) from public.memories m where m.topic_id = t.id and m.ended_at is null)::int memories,
    (select count(*) from public.tasks k where k.topic_id = t.id and k.status <> 'done')::int tasks,
    (select count(*) from public.topic_repositories r where r.topic_id = t.id)::int repositories
  from public.topics t order by t.created_at`);
const personal = await sql(`select kind, count(*)::int n from public.memories
  where topic_id is null and ended_at is null group by kind order by kind`);
const moved = await sql(`select e.created_at, e.before, e.after, e.actor, e.reason, m.kind, left(m.statement, 90) statement
  from public.memory_events e join public.memories m on m.id = e.memory_id
  where e.action = 'moved' and ${inWindow('e.created_at')} order by e.created_at`);
const merges = await sql(`select g.created_at, f.slug from_slug, i.slug into_slug, cardinality(g.memory_ids) memories,
    g.actor, g.reason, g.undone_at
  from public.topic_merges g join public.topics f on f.id = g.from_id join public.topics i on i.id = g.into_id
  where ${inWindow('g.created_at')} or (g.undone_at is not null and ${inWindow('g.undone_at')}) order by g.created_at`);
// What the pass and the tidy said they did, from the job rows.
const actions = await sql(`select j.started_at, r->>'document' document, a->>'did' did, a->>'statement' statement, a->>'why' why
  from public.consolidation_jobs j, jsonb_array_elements(j.runs) r, jsonb_array_elements(coalesce(r->'actions', '[]'::jsonb)) a
  where ${inWindow('j.started_at')} and a->>'did' in ('made topic', 'moved', 'merged topic', 'failed')
    and (r->>'document' = 'tidy' or a->>'did' = 'made topic') order by j.started_at`);
const tidyRan = await sql(`select j.started_at, r->>'failed' failed, (r->>'moved')::int moved, (r->>'merged')::int merged,
    (r->>'topics')::int topics, (r->>'dropped')::int dropped
  from public.consolidation_jobs j, jsonb_array_elements(j.runs) r
  where ${inWindow('j.started_at')} and r->>'document' = 'tidy' order by j.started_at`);

const live = topics.filter(t => !t.merged);
const weekAgo = Date.parse(until) - 7 * 24 * 3600 * 1000;
// Made by Satchel, a week old, and still holding one memory or none: either a
// subject that was too narrow, or one the next facts went elsewhere from.
const thin = live.filter(t => t.made_by === 'satchel' && t.memories <= 1 && Date.parse(t.created_at) < weekAgo);
// Names that share a word. "email-pacing" and "email-templates" can be two
// subjects; "deploys" and "deploy-pipeline" are usually one. The reviewer says which.
const words = slug => new Set(slug.split('-').filter(w => w.length > 2));
const overlap = [];
for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
  const shared = [...words(live[i].slug)].filter(w => words(live[j].slug).has(w));
  if (shared.length) overlap.push({a: live[i].slug, b: live[j].slug, shared: shared.join(', ')});
}

const table = (head, rows) => rows.length
  ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
  : 'none';
const day = value => value ? String(value).slice(0, 16).replace('T', ' ') : '';
const lines = [
  `# Topics · ${day(since)} to ${day(until)}`, '',
  `${live.length} topics (${live.filter(t => t.made_by === 'satchel').length} made by Satchel) · ${topics.length - live.length} merged away`
    + ` · personal holds ${personal.map(p => `${p.n} ${p.kind}`).join(', ') || 'nothing'}`, '',
  '## The numbers', '',
  table(['', 'in this window'], [
    ['topics made', actions.filter(a => a.did === 'made topic').length],
    ['memories moved', moved.length],
    ['merges', merges.filter(m => m.created_at > since).length],
    ['merges undone', merges.filter(m => m.undone_at).length],
    ['tidy runs', `${tidyRan.length}${tidyRan.some(t => t.failed) ? ` (${tidyRan.filter(t => t.failed).length} failed)` : ''}`],
    ['thin topics (Satchel made, a week old, 0 or 1 memory)', thin.length],
    ['name overlaps to judge', overlap.length],
  ]), '',
  '## Every topic', '',
  table(['slug', 'made by', 'since', 'memories', 'open tasks', 'repos'],
    live.map(t => [t.slug, t.made_by, day(t.created_at).slice(0, 10), t.memories, t.tasks, t.repositories])), '',
  '## Made, moved and merged in this window', '',
  table(['when', 'what', 'detail', 'why'], [
    ...actions.filter(a => a.did === 'made topic').map(a => [day(a.started_at), 'made topic', a.statement, a.why ?? '']),
    ...moved.map(m => [day(m.created_at), `moved ${m.before} → ${m.after}`, `[${m.kind}] ${m.statement}`, m.reason ?? '']),
    ...merges.map(m => [day(m.created_at), `merged ${m.from_slug} → ${m.into_slug}${m.undone_at ? ' (undone)' : ''}`,
      `${m.memories} memories`, m.reason ?? '']),
    ...actions.filter(a => a.did === 'failed').map(a => [day(a.started_at), 'failed', a.statement, a.why ?? '']),
  ]), '',
  '## Signals to judge', '',
  `Thin topics: ${thin.map(t => `${t.slug} (${t.memories})`).join(', ') || 'none'}`, '',
  'Name overlaps:', '',
  table(['topic', 'topic', 'shared word'], overlap.map(o => [o.a, o.b, o.shared])), '',
];
const text = lines.join('\n') + '\n';
writeFileSync(join(folder, 'topics.md'), text, {mode: 0o600});
writeFileSync(join(folder, 'topics.json'), JSON.stringify({topics, personal, moved, merges, actions, tidyRan, thin, overlap}, null, 1), {mode: 0o600});
console.log(text);
