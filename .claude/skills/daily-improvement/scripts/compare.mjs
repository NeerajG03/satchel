#!/usr/bin/env node
// The counting half of step 4 and 5 of the review, so it is not done by hand.
// Reads a folder that collect.mjs wrote and the blind answers
// (blind/out-*.json), prints the numbers and writes them to <folder>/numbers.md.
// Judging what a change is worth stays with the reviewer.
//
//   node compare.mjs <folder>
//
// Plain node, no packages, reads files only.
import {readFileSync, readdirSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const folder = process.argv[2];
if (!folder) throw new Error('usage: compare.mjs <folder>');
const read = path => readFileSync(join(folder, path), 'utf8');
const json = path => JSON.parse(read(path));

const {sessions} = json('blind/INDEX.json');
const traces = existsSync(join(folder, 'langfuse.json')) ? Object.values(json('langfuse.json').traces ?? {}) : [];
const traceOf = name => traces.find(t => String(t.metadata?.document ?? '').startsWith(name));

// What the pass did, read off the lines collect.mjs wrote under "What landed".
const pipeline = {};
for (const {name} of sessions) {
  const text = read(`pipeline/${name}.md`);
  const landed = [...text.matchAll(/^- (added|extended|replaced|retired) \[(\w+) · (.+?) · \w+\]/gm)]
    .map(([, action, kind, scope]) => ({action, kind, scope}));
  // The same affirm can show twice, as a "confirmed" row and as a line from the
  // job report, so the job's own count decides how many there were.
  const confirmed = [...text.matchAll(/^- confirmed \[(\w+) · (.+?) · \w+\]/gm)].map(([, kind, scope]) => ({action: 'affirmed', kind, scope}));
  const affirms = Number(text.match(/affirmed (\d+) rejected/)?.[1] ?? confirmed.length);
  for (let i = 0; i < affirms; i++) landed.push(confirmed[i] ?? {action: 'affirmed', kind: null, scope: null});
  pipeline[name] = {landed, rejected: Number(text.match(/rejected (\d+)/)?.[1] ?? 0), error: /error (?!none)\S/.test(text.split('\n')[2] ?? '')};
}

// What the blind readers answered.
const blind = {};
const outs = readdirSync(join(folder, 'blind')).filter(f => /^out-\d+\.json$/.test(f));
if (!outs.length) console.warn('no blind/out-*.json yet: the blind side is empty');
for (const f of outs) for (const s of json(`blind/${f}`)) blind[s.session] = s.changes ?? [];

const count = (list, test) => list.filter(test).length;
const sum = (names, pick) => names.reduce((n, name) => n + pick(name), 0);
const names = sessions.map(s => s.name);
const scopeOf = Object.fromEntries(sessions.map(s => [s.name, s.scope]));
const unlinked = names.filter(n => scopeOf[n] === 'personal');
const inTopic = c => c.scope && c.scope !== 'personal';
const blindIn = c => c.memory_scope && c.memory_scope !== 'personal';

const row = (label, p, b) => `| ${label} | ${p} | ${b} |`;
const pl = name => pipeline[name].landed;
const bl = name => blind[name] ?? [];
const kinds = ['fact', 'preference', 'intent'];
const actions = ['added', 'extended', 'replaced', 'retired', 'affirmed'];
const blindAction = {added: 'add', extended: 'extend', replaced: 'replace', retired: 'retire', affirmed: 'affirm'};

const lines = [];
lines.push('## The numbers', '', '|  | pipeline | blind |', '|---|---:|---:|');
lines.push(row('changes', sum(names, n => pl(n).length), sum(names, n => bl(n).length)));
lines.push(row('sessions with any', count(names, n => pl(n).length), count(names, n => bl(n).length)));
lines.push(row('sessions with any on both sides', count(names, n => pl(n).length && bl(n).length), ''));
// A session the blind side never answered (a failed run, a batch that did not
// run) is not an empty blind answer, so it is left out of that count and named.
const unanswered = names.filter(n => !(n in blind));
lines.push(row('empty answers', count(names, n => !pl(n).length), count(names, n => n in blind && !bl(n).length)));
lines.push(row('sessions with no blind answer', '', unanswered.length));
lines.push(row('topic-scoped', sum(names, n => count(pl(n), inTopic)), sum(names, n => count(bl(n), blindIn))));
lines.push(row('topic-scoped from sessions with no topic',
  sum(unlinked, n => count(pl(n), inTopic)), sum(unlinked, n => count(bl(n), blindIn))));
lines.push(row(`sessions with no topic`, `${unlinked.length} of ${names.length}`, ''));
for (const kind of kinds) lines.push(row(`${kind}s`, sum(names, n => count(pl(n), c => c.kind === kind)),
  sum(names, n => count(bl(n), c => c.kind === kind))));
lines.push(row('add / extend / replace / retire / affirm',
  actions.map(a => sum(names, n => count(pl(n), c => c.action === a))).join(' / '),
  actions.map(a => sum(names, n => count(bl(n), c => c.action === blindAction[a]))).join(' / ')));
lines.push(row('rejected by the checks', sum(names, n => pipeline[n].rejected), ''));

lines.push('', '## Per session', '', '| session | scope | turns | characters | pipeline | blind | rejected |', '|---|---|---:|---:|---:|---:|---:|');
for (const s of sessions) lines.push(`| ${s.name} | ${s.scope} | ${s.turns} | ${s.chars} | ${pl(s.name).length} | ${bl(s.name).length} | ${pipeline[s.name].rejected} |`);

// Did both sides start from the same memory set? A blind file that lists more
// memories than the pass was shown has the pass's own adds in it, and "both"
// cannot be trusted (TODO 15 of 29 September).
lines.push('', '## Same input on both sides', '');
const differ = [];
// A run that failed has no blind file, so there is nothing to compare for it.
for (const s of sessions) {
  if (!existsSync(join(folder, `blind/${s.name}.md`))) continue;
  const known = traceOf(s.name)?.metadata?.knownMemories;
  const blindList = read(`blind/${s.name}.md`).split('## Memories that already')[1]?.split('## The new turns')[0] ?? '';
  const shown = (blindList.match(/^\d+\. \[/gm) ?? []).length;
  if (known != null && known !== shown) differ.push(`${s.name} (blind ${shown}, pass saw ${known})`);
}
lines.push(differ.length
  ? `**WARNING: ${differ.length} of ${sessions.length} sessions differ: ${differ.join(', ')}.** The blind side was shown memories the pass did not see, so "both" is unproven.`
  : `same on all ${sessions.length} sessions`);

// Runtime, from Langfuse.
if (traces.length) {
  const meta = t => t.metadata ?? {};
  const done = sessions.map(s => traceOf(s.name)).filter(Boolean);
  const cost = done.reduce((n, t) => n + (t.generations?.[0]?.cost ?? 0), 0);
  lines.push('', '## Runtime', '',
    `${done.length} of ${sessions.length} runs traced · models ${[...new Set(done.map(t => meta(t).modelUsed))].join(', ')} · thinking ${[...new Set(done.map(t => meta(t).thinking))].join(', ')}`
    + ` · prompt ${[...new Set(done.map(t => `${meta(t).promptSource}/${meta(t).promptVersion}`))].join(', ')}`
    + ` · ${count(done, t => meta(t).waited)} waited · ${count(done, t => t.level && t.level !== 'DEFAULT')} not at default level`
    + ` · ${sum(names, n => pipeline[n].error ? 1 : 0)} with an error · cost $${cost.toFixed(2)}`, '',
    '| session | characters | reasoning | output | seconds | cost |', '|---|---:|---:|---:|---:|---:|');
  for (const s of sessions) {
    const t = traceOf(s.name);
    if (t) lines.push(`| ${s.name} | ${meta(t).characters} | ${meta(t).reasoningTokens ?? ''} | ${meta(t).outputTokens ?? ''} | ${t.latency_s} | $${(t.generations?.[0]?.cost ?? 0).toFixed(3)} |`);
  }
}

const text = lines.join('\n') + '\n';
writeFileSync(join(folder, 'numbers.md'), text, {mode: 0o600});
console.log(text);
