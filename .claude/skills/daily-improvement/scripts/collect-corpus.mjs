#!/usr/bin/env node
// Builds the real-data eval corpus: the conversations worth judging, whole, and
// nothing the pass ever said about them. Reads only.
//
//   node collect-corpus.mjs [--dir ~/satchel-daily/real-eval] [--max 40] [--quiet 8]
//
// It writes, under the folder (created private, never committed):
//   sessions/<id>.json   the turns and the topic the session had, for the eval
//   blind/<id>.md        the same, as a labeller reads it: topics and turns only
//   index.json           what was picked and why, and the labelling batches
//
// "Best" here is: enough of the person's own words to hold a memory (three or
// more turns from them, 800 or more characters), not an automated prompt, and
// spread across the days available. A few quiet sessions are kept on purpose,
// because a pass that only ever finds memories has not been tested for restraint.
import {mkdirSync, writeFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from './db.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dir = flag('--dir', join(process.env.HOME, 'satchel-daily', 'real-eval'));
const MAX = Number(flag('--max', 40));
const QUIET = Number(flag('--quiet', 8));
const BATCH_CHARS = 90_000;

for (const sub of ['sessions', 'blind']) mkdirSync(join(dir, sub), {recursive: true, mode: 0o700});
chmodSync(dir, 0o700);
const write = (path, text) => writeFileSync(join(dir, path), text, {mode: 0o600});

const documents = await sql(`select d.id, d.session_key, d.topic_id, d.last_turn_at,
    (select count(*)::int from public.document_turns t where t.document_id = d.id and t.role = 'user') user_turns,
    (select coalesce(sum(length(content)), 0)::int from public.document_turns t where t.document_id = d.id and t.role = 'user') user_chars
  from public.documents d order by d.last_turn_at`);
const topics = await sql(`select id, slug, name, brief from public.topics order by slug`);
const repos = await sql(`select topic_id, repository from public.topic_repositories`);
const slugOf = Object.fromEntries(topics.map(p => [p.id, p.slug]));
write('topics.json', JSON.stringify(topics.map(p => ({slug: p.slug, brief: p.brief ?? p.name ?? '',
  repositories: repos.filter(r => r.topic_id === p.id).map(r => r.repository)})), null, 1));

const day = d => new Date(d.last_turn_at).toISOString().slice(0, 10);
const usable = documents.filter(d => d.user_chars >= 400);
const rich = usable.filter(d => d.user_turns >= 3 && d.user_chars >= 800);
const quiet = usable.filter(d => !rich.includes(d) && d.user_chars < 800);

// Round robin over days, newest first inside a day, so no one night fills the set.
const byDay = new Map();
for (const d of [...rich].reverse()) byDay.set(day(d), [...(byDay.get(day(d)) ?? []), d]);
const picked = [];
while (picked.length < MAX && [...byDay.values()].some(list => list.length))
  for (const list of byDay.values()) if (list.length && picked.length < MAX) picked.push(list.shift());
const quietPicked = quiet.slice(-QUIET);

const chosen = [];
for (const d of [...picked, ...quietPicked]) {
  const turns = await sql(`select role, content, created_at from public.document_turns
    where document_id = '${d.id}' order by id`);
  // Automated prompts (a task notification, a scheduled task) are not the person.
  const first = turns.find(t => t.role === 'user')?.content ?? '';
  if (/^<(task-notification|scheduled-task)/.test(first.trim()) && d.user_turns < 3) continue;
  const name = d.id.slice(0, 8);
  const topic = d.topic_id ? slugOf[d.topic_id] ?? null : null;
  write(`sessions/${name}.json`, JSON.stringify({id: d.id, name, topic, day: day(d),
    quiet: quietPicked.includes(d), turns}, null, 1));
  const lines = [`# Session ${name} · scope: ${topic ?? 'personal'}`, '', '## Topics that exist', '',
    ...topics.map(p => `- ${p.slug}: ${(p.brief ?? p.name ?? '').slice(0, 220)}`
      + (repos.some(r => r.topic_id === p.id)
        ? ` (repos: ${repos.filter(r => r.topic_id === p.id).map(r => r.repository).join(', ')})` : '')),
    '', '## The conversation', '',
    // The labeller judges the person's words; the assistant's half is only there
    // to make "yes, that one" readable, so it is shortened. The eval still gets
    // every turn whole from sessions/.
    ...turns.map(t => `### ${t.role} · ${t.created_at}\n\n${t.role === 'assistant' && t.content.length > 1500
      ? t.content.slice(0, 1500) + '\n[shortened for the labeller]' : t.content}\n`)];
  write(`blind/${name}.md`, lines.join('\n'));
  chosen.push({name, topic, day: day(d), user_turns: d.user_turns, chars: lines.join('\n').length,
    quiet: quietPicked.includes(d)});
}

const batches = [];
let current = {files: [], chars: 0};
for (const c of chosen) {
  if (current.files.length && current.chars + c.chars > BATCH_CHARS) { batches.push(current); current = {files: [], chars: 0}; }
  current.files.push(`${c.name}.md`); current.chars += c.chars;
}
if (current.files.length) batches.push(current);
write('index.json', JSON.stringify({made: new Date().toISOString(), sessions: chosen, batches}, null, 1));
console.log(`${chosen.length} sessions (${quietPicked.length} quiet) from ${documents.length} documents, `
  + `${batches.length} batches. Folder: ${dir}`);
