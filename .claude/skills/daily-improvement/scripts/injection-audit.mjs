#!/usr/bin/env node
// The read side of the daily review: what retrieval put in front of the agent
// on real prompts, and what the retrieval rules in a checkout would have put
// there instead.
//
//   node injection-audit.mjs [--days 7] [--checkout <dir>]
//
// The consolidation review watches what gets written. Nothing watched what
// gets read, and the week this was written, 57% of prompt-time hits went to
// text the host produced rather than the person, and three memories took half
// of all slots. This replays every retrieve-memory span in the window through
// two rules from the checkout given (default: this one): which prompts count
// as the person's, and which rows session start had already loaded. It prints
// before and after, so a change to those rules is measured on real traffic
// before it deploys.
//
// Read only. Prompts are classified and counted, never printed. Memory
// statements are printed, cut short, because they are the thing being judged.
import {sql} from './db.mjs';
import {observations} from './langfuse.mjs';
import {join} from 'node:path';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DAYS = Number(flag('--days') ?? 7);
const CHECKOUT = flag('--checkout') ?? join(import.meta.dirname, '../../../..');

const {classifyPrompt} = await import(join(CHECKOUT, 'server/machine-prompt.mjs'));
const {personalLoad} = await import(join(CHECKOUT, 'server/injection-format.mjs'));

const until = new Date();
const since = new Date(until.getTime() - DAYS * 86400e3);

// Every live memory, so a row in a span can be named and scoped. Ended rows
// are kept too: a span from last week may name one that has since been ended.
const memories = Object.fromEntries((await sql(`select m.id, m.statement, m.topic_id, m.band, m.kind, m.ended_at, p.slug
  from public.memories m left join public.topics p on p.id = m.topic_id`)).map(m => [m.id, m]));
// What session start loads today: the personal rows, in the block's own order
// and under its cap. The after-rule excludes exactly these.
const settings = (await sql(`select block_size from public.memory_settings limit 1`))[0] ?? {block_size: 30};
const personal = await sql(`select id, statement, band, mentions, affirmed_at, updated_at from public.memories
  where topic_id is null and ended_at is null order by mentions desc, affirmed_at desc, updated_at desc, id`);
const load = personalLoad(personal, settings.block_size ?? 30);
const loaded = new Set([...load.said, ...load.heard].map(m => m.id));

const rows = await observations(since.toISOString(), until.toISOString(),
  {limit: 20000, fields: 'core,basic,io,metadata'});
const spans = rows.filter(r => r.name === 'retrieve-memory');

const tally = () => ({prompts: 0, hits: 0, slots: 0, slotsOnMachine: 0, personalSlots: 0, byMemory: {}});
const before = tally(), after = tally();
const kinds = {};
const count = (t, shown, machine) => {
  t.prompts += 1;
  if (!shown.length) return;
  t.hits += 1;
  t.slots += shown.length;
  if (machine) t.slotsOnMachine += shown.length;
  for (const row of shown) {
    const id = row.id ?? row;
    if (memories[id]?.topic_id == null) t.personalSlots += 1;
    t.byMemory[id] = (t.byMemory[id] ?? 0) + 1;
  }
};
for (const span of spans) {
  const prompt = typeof span.input === 'string' ? span.input : JSON.stringify(span.input ?? '');
  const {kind} = classifyPrompt(prompt);
  if (kind) kinds[kind] = (kinds[kind] ?? 0) + 1;
  // The SDK stores the span's output as a JSON string.
  let shown = span.output;
  if (typeof shown === 'string') { try { shown = JSON.parse(shown); } catch { shown = []; } }
  if (!Array.isArray(shown)) shown = [];
  count(before, shown, Boolean(kind));
  // After: a machine prompt is not searched, and a row the block already
  // loaded is not shown again.
  count(after, kind ? [] : shown.filter(row => !loaded.has(row.id ?? row)), false);
}

const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
const line = (label, a, b) => console.log(`  ${label.padEnd(34)} ${String(a).padStart(8)} ${String(b).padStart(8)}`);
console.log(`retrieve-memory spans, last ${DAYS} days: ${spans.length} prompts, ${Object.values(kinds).reduce((s, n) => s + n, 0)} from the host or another agent`);
for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`    ${kind.padEnd(22)} ${n}`);
console.log('');
console.log(`  ${''.padEnd(34)} ${'before'.padStart(8)} ${'after'.padStart(8)}`);
line('prompts that got any memory', `${before.hits} (${pct(before.hits, before.prompts)})`, `${after.hits} (${pct(after.hits, after.prompts)})`);
line('slots injected', before.slots, after.slots);
line('slots on machine prompts', `${before.slotsOnMachine} (${pct(before.slotsOnMachine, before.slots)})`, `${after.slotsOnMachine} (${pct(after.slotsOnMachine, after.slots)})`);
line('slots that session start had loaded', `${before.personalSlots} (${pct(before.personalSlots, before.slots)})`, `${after.personalSlots} (${pct(after.personalSlots, after.slots)})`);
const human = spans.filter(s => !classifyPrompt(typeof s.input === 'string' ? s.input : '').kind);
const humanHits = human.filter(s => (s.metadata?.shown ?? 0) > 0).length;
line('human prompts that got any memory', `${humanHits} of ${human.length} (${pct(humanHits, human.length)})`, '');
console.log('');
const top = (t, n = 8) => Object.entries(t.byMemory).sort((a, b) => b[1] - a[1]).slice(0, n);
for (const [label, t] of [['before', before], ['after', after]]) {
  console.log(`  most injected, ${label}:`);
  for (const [id, n] of top(t)) {
    const m = memories[id];
    const where = m ? (m.topic_id ? m.slug : 'personal') + (m.band === 'heard' ? ', picked up' : '') + (m.ended_at ? ', ended' : '') : 'unknown';
    console.log(`    ${String(n).padStart(4)}  (${where})  ${String(m?.statement ?? id).slice(0, 90)}`);
  }
  console.log('');
}
