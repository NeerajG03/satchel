#!/usr/bin/env node
// How often each rule is said again, and the following score, for step 5's
// following question. Reads only.
//
//   node said-again.mjs <folder> [--weeks 4] [--min 2] [--following <file>]
//
// An affirm bumps `mentions` and `affirmed_at` and writes no memory_events row,
// so the only record of one is the run that made it: the prompt head lists the
// memories as `  #n  [kind, scope, said N times, ...]  statement` and the
// response names `#n` as the target of an `affirm`. This joins the two, the
// way scenario E did by hand, and counts affirms per rule per week over the
// last --weeks calendar weeks (Monday to Sunday, UTC), the last one running up
// to the folder's window end. A rule affirmed fewer than --min times in that
// span is left out of the week's table, but every affirm still gets a line and
// a `mark:` to fill.
//
// The following score (D50): complaints on a rule that was in that session's
// start block, per 100 sessions. Sessions are distinct session keys with a
// SessionStart row in memory_injections, each counted in the week of its first
// start in the window, since a resume or a clear writes another row for the
// same session. Each week's numbers are kept in --following (default
// ~/satchel-daily/following.json), one entry per week, so the 4 weeks before
// can be read after the run text that made them is blanked.
//
// What it cannot see: an affirm the twin check made (`reconsider`) is not in
// the response, so a run whose `affirmed` column exceeds the parsed affirms
// shows the difference as `missing`; run text is blanked at 30 days, so the
// count looks no further back than that; and an add says nothing about whether
// the person was correcting the agent, so complaints about rules not yet in
// memory are not counted.
//
// Writes <folder>/said-again.md. It holds the person's own words (the `source`
// of each affirm), so it stays in the folder. Stdout and following.json get
// the numbers only.
import {readFileSync, writeFileSync, readdirSync, realpathSync, mkdirSync} from 'node:fs';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sql, lit} from './db.mjs';

const DAY = 24 * 3600 * 1000;
const handleOf = id => String(id).replace(/-/g, '').slice(0, 6);
const day = value => new Date(value).toISOString().slice(0, 10);
const clip = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** The Monday (UTC) that starts the week holding this moment, as YYYY-MM-DD. */
export const weekOf = value => {
  const t = new Date(value);
  const monday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - ((t.getUTCDay() + 6) % 7) * DAY);
  return monday.toISOString().slice(0, 10);
};

/** The memory lines of a prompt head, by their number. The bracket is read
 *  loosely: kind first, scope second, `said N times` wherever it sits, and
 *  anything else (`last on`, `made on`, `repo +N commits since`) is ignored. */
export function parsePromptMemories(prompt) {
  const memories = new Map();
  for (const [, n, bracket, statement] of String(prompt ?? '').matchAll(/^ {2}#(\d+) {2}\[(.*?)\] {2}(.*)$/gm)) {
    const parts = bracket.split(',').map(p => p.trim());
    const said = parts.map(p => p.match(/^said (\d+) times$/)).find(Boolean);
    memories.set(Number(n), {n: Number(n), kind: parts[0] ?? null, scope: parts[1] ?? null,
      mentionsThen: said ? Number(said[1]) : 1, statement: statement.trim()});
  }
  return memories;
}

/** One run's affirms, joined to the statements its prompt numbered.
 *
 *  `missing` is how many affirms the run counted that the response does not
 *  name: those came from the twin check, which answers outside the response.
 *  `expired` means the run text was blanked, so nothing could be read. */
export function parseRun(run) {
  const expired = run.prompt == null || /^\((expired|not sent)\)$/.test(String(run.prompt).trim());
  const memories = expired ? new Map() : parsePromptMemories(run.prompt);
  let changes = [];
  if (!expired && run.response) {
    try { changes = JSON.parse(run.response)?.changes ?? []; } catch { changes = []; }
  }
  const affirms = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    if (change?.action !== 'affirm') continue;
    const target = memories.get(Number(change.target)) ?? null;
    affirms.push({run: run.id, when: run.created_at, session_key: run.session_key ?? null, n: Number(change.target),
      kind: target?.kind ?? change.kind ?? null, scope: target?.scope ?? change.topic ?? null,
      mentionsThen: target?.mentionsThen ?? null, statement: target?.statement ?? null,
      source: String(change.source ?? ''), joined: Boolean(target)});
  }
  const affirmed = Number(run.affirmed ?? 0);
  return {run: run.id, when: run.created_at, session_key: run.session_key ?? null, affirms, affirmed, expired,
    missing: Math.max(0, affirmed - affirms.length)};
}

/** Affirms grouped by week, then by rule. A rule is its `key` (a memory id when
 *  one was found, else the statement text), so the same rule under one key
 *  across weeks adds up. Weeks come back oldest first, rules most affirmed first. */
export function byWeek(affirms) {
  const weeks = new Map();
  for (const affirm of affirms) {
    const week = weekOf(affirm.when);
    const key = affirm.key ?? affirm.statement ?? `#${affirm.n} in run ${affirm.run}`;
    if (!weeks.has(week)) weeks.set(week, new Map());
    const rules = weeks.get(week);
    if (!rules.has(key)) rules.set(key, {key, statement: affirm.statement, affirms: []});
    rules.get(key).affirms.push(affirm);
  }
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, rules]) => ({
    week, rules: [...rules.values()].map(r => ({...r, count: r.affirms.length}))
      .sort((a, b) => b.count - a.count || String(a.statement).localeCompare(String(b.statement)))}));
}

/** The start of the window: the Monday that starts the week `weeks - 1`
 *  weeks before the one holding `until`, so every week but the last is whole. */
export const windowStart = (until, weeks) =>
  new Date(Date.parse(weekOf(until)) - (weeks - 1) * 7 * DAY).toISOString();

/** Distinct sessions per week. Each session counts once, in the week of its
 *  earliest SessionStart row given here. */
export function sessionsByWeek(rows) {
  const first = new Map();
  for (const {session_key: key, created_at: when} of rows) {
    if (!key) continue;
    if (!first.has(key) || Date.parse(when) < Date.parse(first.get(key))) first.set(key, when);
  }
  const weeks = new Map();
  for (const when of first.values()) weeks.set(weekOf(when), (weeks.get(weekOf(when)) ?? 0) + 1);
  return weeks;
}

/** One entry per week from `since` to `until`: numbers only, never words. */
export function followingWeeks({since, until, affirms, inBlock, sessions}) {
  const entries = [];
  for (let t = Date.parse(weekOf(since)); t <= Date.parse(until); t += 7 * DAY) {
    const week = new Date(t).toISOString().slice(0, 10);
    const these = affirms.filter(a => weekOf(a.when) === week);
    const loaded = a => Boolean(a.id && a.session_key && inBlock.has(`${a.session_key} ${a.id}`));
    entries.push({week, sessions: sessions.get(week) ?? 0, affirms: these.length,
      complaints_in_block: these.filter(a => a.mark === 'complaint' && loaded(a)).length,
      complaints: these.filter(a => a.mark === 'complaint').length,
      up_front: these.filter(a => a.mark === 'up-front').length,
      unlabelled: these.filter(a => !a.mark).length});
  }
  return entries;
}

const per100 = entries => {
  const sessions = entries.reduce((n, e) => n + e.sessions, 0);
  const complaints = entries.reduce((n, e) => n + e.complaints_in_block, 0);
  return sessions ? (complaints / sessions * 100).toFixed(1) : 'n/a';
};

/** The one line the report and the log open with. `before` is what
 *  following.json kept for the weeks ahead of the window; a week it does not
 *  hold is said, not guessed. */
export function followingLine({weeks, entries, before}) {
  const sum = key => entries.reduce((n, e) => n + e[key], 0);
  const was = before.length === 0 ? 'none kept yet'
    : `${per100(before)}${before.length < weeks ? ` (${before.length} of ${weeks} weeks kept)` : ''}`;
  return `following: ${sum('complaints_in_block')} complaints in ${weeks} weeks · per 100 sessions: ${per100(entries)} · `
    + `${weeks} weeks before: ${was} · up-front ${sum('up_front')} · unlabelled ${sum('unlabelled')}`;
}

/** following.json with this run's weeks put in: a week already there is
 *  replaced, the rest are kept, oldest first. */
export function upsertFollowing(doc, entries, asOf) {
  const weeks = new Map((doc?.weeks ?? []).map(e => [e.week, e]));
  for (const e of entries) weeks.set(e.week, {...e, as_of: asOf});
  return {weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week))};
}

/** The markdown. Everything with the person's words in it goes here and
 *  nowhere else; `headline` is the part that may be printed. */
export function render({since, until, weeks, min, runs, parsed, affirms, live, inBlock, following = null}) {
  const totals = new Map();
  for (const a of affirms) totals.set(a.key, (totals.get(a.key) ?? 0) + 1);
  const atMin = [...totals.entries()].filter(([, n]) => n >= min);
  const withText = parsed.filter(p => !p.expired);
  const missing = parsed.reduce((n, p) => n + (p.expired ? 0 : p.missing), 0);
  const expiredAffirms = parsed.reduce((n, p) => n + (p.expired ? p.affirmed : 0), 0);
  const blockable = affirms.filter(a => a.id && a.session_key);
  const loaded = blockable.filter(a => inBlock.has(`${a.session_key} ${a.id}`));
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
  const isId = key => /^[0-9a-f-]{36}$/.test(String(key));
  const marks = affirms.map(a => a.mark).filter(Boolean);
  const share = label => marks.filter(m => m === label).length;

  const onAtMin = atMin.reduce((n, [, c]) => n + c, 0);
  const topText = top ? `top ${isId(top[0]) ? handleOf(top[0]) : 'text only'} x${top[1]}` : 'top none';
  const headline = [
    ...(following ? [following, ''] : []),
    `# Said again · ${day(since)} to ${day(until)} · ${weeks} weeks`, '',
    `${runs.total} runs · ${withText.length} with an affirm read · ${runs.expired} expired (text blanks at 30 days, ${expiredAffirms} affirms in them not counted)`,
    `${affirms.length} affirms parsed · ${missing} missing (counted by the run, not in its response: the twin check made them)`,
    `${atMin.length} rules at ${min}+ · in block ${loaded.length} of ${blockable.length} (affirmed while the rule was already in that session's start block) · ${topText}`,
    `marks: complaint ${share('complaint')} · up-front ${share('up-front')} · unmarked ${affirms.length - marks.length} (fill every mark line below, then re-run to count them)`, '',
    `report line: Said again: ${onAtMin} affirms on ${atMin.length} rules at ${min}+ · complaint ${share('complaint')} · up-front ${share('up-front')} · ${topText}, in block ${loaded.length} of ${blockable.length}`,
  ];

  const lines = [...headline, ''];
  const table = (head, rows) => rows.length
    ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
    : 'none';
  const inBlockOf = rule => {
    const can = rule.affirms.filter(a => a.id && a.session_key);
    return can.length ? `${can.filter(a => inBlock.has(`${a.session_key} ${a.id}`)).length} of ${can.length}` : 'no key';
  };
  const handle = rule => rule.affirms[0].id ? handleOf(rule.affirms[0].id) : 'none';
  const mentionsNow = rule => live.get(rule.key)?.mentions ?? '';

  for (const {week, rules} of byWeek(affirms)) {
    const shown = rules.filter(r => (totals.get(r.key) ?? 0) >= min);
    const folded = rules.filter(r => (totals.get(r.key) ?? 0) < min);
    lines.push(`## Week of ${week}`, '',
      table(['handle', 'statement', 'affirms', 'mentions now', 'in block'],
        shown.map(r => [handle(r), clip(r.statement ?? r.key, 60).replace(/\|/g, '/'), r.count, mentionsNow(r), inBlockOf(r)])), '');
    if (folded.length) lines.push(`${folded.length} more under ${min} in this span: ${folded.map(r => `${handle(r)} x${r.count}`).join(', ')}`, '');
    for (const rule of [...shown, ...folded]) {
      lines.push(`### ${handle(rule)} · ${clip(rule.statement ?? rule.key, 60)}`, '');
      for (const a of rule.affirms) {
        const where = a.id && a.session_key ? (inBlock.has(`${a.session_key} ${a.id}`) ? 'in block' : 'not in block') : 'no key';
        lines.push(`- ${day(a.when)} · session ${a.session_key ? String(a.session_key).slice(0, 8) : 'none'} · run ${handleOf(a.run)} #${a.n} · ${where}${a.joined ? '' : ' · not in the prompt'}`);
        lines.push(`  source: "${clip(a.source, 200).replace(/"/g, "'")}"`);
        lines.push(`  mark: ${a.mark ?? ''}`.trimEnd());
      }
      lines.push('');
    }
  }

  lines.push('## Missing', '', 'Runs whose `affirmed` count is more than the affirms the response names. The twin check (`reconsider`) affirms outside the response; the job report entry in `pipeline/<name>.md` says which memory.', '',
    table(['run', 'when', 'session', 'affirmed', 'parsed', 'missing'],
      withText.filter(p => p.missing > 0).map(p => [handleOf(p.run), day(p.when), p.session_key ? String(p.session_key).slice(0, 8) : 'none', p.affirmed, p.affirms.length, p.missing])), '');
  return {headline: headline.join('\n'), text: lines.join('\n') + '\n'};
}

/** The `mark:` lines a reviewer filled in on the last run of this script, so a
 *  re-run keeps them. Keyed by run and target number, which do not change;
 *  two affirms on one target in one run are kept in file order. */
export function readMarks(text) {
  const marks = new Map();
  if (!text) return marks;
  // Every mark line is kept, blank ones too, so positions hold.
  for (const m of text.matchAll(/^- \S+ · session \S+ · run ([0-9a-f]{6} #\d+) [^\n]*\n {2}source: [^\n]*\n {2}mark:[ \t]*([^\n]*)$/gm)) {
    const mark = m[2].trim();
    marks.set(m[1], [...(marks.get(m[1]) ?? []), /^(complaint|up-front)$/.test(mark) ? mark : null]);
  }
  return marks;
}

/** Marks from this folder's file, with any blank one filled from the newest
 *  earlier review's file, so a new day starts with what was already marked. */
export function mergeMarks(current, earlier) {
  const merged = new Map(earlier);
  for (const [key, marks] of current) {
    const old = earlier.get(key) ?? [];
    merged.set(key, Array.from({length: Math.max(marks.length, old.length)}, (_, i) => marks[i] ?? old[i] ?? null));
  }
  return merged;
}

/** The newest sibling folder before this one that has a said-again.md. */
export function earlierFolder(folder) {
  const parent = dirname(folder);
  const name = basename(folder);
  let names = [];
  try { names = readdirSync(parent); } catch { return null; }
  const found = names.filter(n => n < name && /^\d{4}-\d{2}-\d{2}/.test(n)).sort().reverse()
    .find(n => { try { readFileSync(join(parent, n, 'said-again.md')); return true; } catch { return false; } });
  return found ? join(parent, found) : null;
}

/** Puts the kept marks back on this run's affirms. */
export function applyMarks(parsed, kept) {
  for (const p of parsed) {
    const seen = new Map();
    for (const a of p.affirms) {
      const key = `${handleOf(p.run)} #${a.n}`;
      const i = seen.get(key) ?? 0;
      seen.set(key, i + 1);
      const mark = kept.get(key)?.[i];
      if (mark) a.mark = mark;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const given = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!given) throw new Error('usage: said-again.mjs <folder> [--weeks 4] [--min 2] [--following <file>]');
  // /var is a link to /private/var on macOS: resolve it so sibling folders and
  // the paths printed are the real ones.
  const folder = realpathSync(given);
  const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const weeks = Number(option('weeks') ?? 4);
  const min = Number(option('min') ?? 2);
  const followingFile = option('following') ?? join(process.env.HOME, 'satchel-daily', 'following.json');
  const {until} = JSON.parse(readFileSync(join(folder, 'window.json'), 'utf8'));
  const since = windowStart(until, weeks);
  const inWindow = `r.created_at >= ${lit(since)} and r.created_at <= ${lit(until)}`;

  // The head only: the prompt is cut before the conversation in the database,
  // so the turns never leave it. A blanked prompt has no marker and comes whole.
  const head = `case when position(E'\\nthe conversation:' in r.prompt) > 0
    then left(r.prompt, position(E'\\nthe conversation:' in r.prompt) - 1) else r.prompt end`;
  const [counts] = await sql(`select count(*)::int total,
      count(*) filter (where r.prompt in ('(expired)', '(not sent)'))::int expired
    from public.consolidation_runs r where ${inWindow}`);
  const rows = await sql(`select r.id, r.created_at, r.affirmed, r.response, d.session_key, ${head} prompt
    from public.consolidation_runs r left join public.documents d on d.id = r.document_id
    where ${inWindow} and (r.affirmed > 0 or r.response like '%"affirm"%') order by r.created_at`);
  const parsed = rows.map(parseRun);
  const affirms = parsed.flatMap(p => p.affirms);

  // Key each affirm to a memory: the live statement, else a statement a
  // memory once had (an extend rewrites it), else the text itself.
  const liveRows = await sql(`select id, statement, mentions, topic_id from public.memories where ended_at is null`);
  const live = new Map(liveRows.map(m => [m.id, m]));
  const byStatement = new Map(liveRows.map(m => [m.statement, m.id]));
  const once = await sql(`select memory_id, after from public.memory_events where after is not null`);
  const byOld = new Map(once.map(e => [e.after, e.memory_id]));
  for (const a of affirms) {
    a.id = a.statement == null ? null : byStatement.get(a.statement) ?? byOld.get(a.statement) ?? null;
    a.key = a.id ?? a.statement ?? `#${a.n} in run ${a.run}`;
  }

  // Was the rule already in that session's start block when it was said again?
  const keys = [...new Set(affirms.map(a => a.session_key).filter(Boolean))];
  const injections = keys.length ? await sql(`select session_key, memory_ids from public.memory_injections
    where event = 'SessionStart' and session_key in (${keys.map(lit).join(', ')})`) : [];
  const inBlock = new Set(injections.flatMap(i => (i.memory_ids ?? []).map(id => `${i.session_key} ${id}`)));

  // The denominator: every session that got a start block in the window.
  const starts = await sql(`select session_key, min(created_at) created_at from public.memory_injections
    where event = 'SessionStart' and created_at >= ${lit(since)} and created_at <= ${lit(until)} group by session_key`);
  const sessions = sessionsByWeek(starts);

  // Marks a reviewer wrote last time stay, and a new day starts from the last day's.
  const out = join(folder, 'said-again.md');
  const marksIn = file => { try { return readMarks(readFileSync(file, 'utf8')); } catch { return new Map(); } };
  const earlier = earlierFolder(folder);
  applyMarks(parsed, mergeMarks(marksIn(out), earlier ? marksIn(join(earlier, 'said-again.md')) : new Map()));

  const entries = followingWeeks({since, until, affirms, inBlock, sessions});
  let kept = {weeks: []};
  try { kept = JSON.parse(readFileSync(followingFile, 'utf8')); } catch { kept = {weeks: []}; }
  const beforeFrom = new Date(Date.parse(since) - weeks * 7 * DAY).toISOString().slice(0, 10);
  const before = (kept.weeks ?? []).filter(e => e.week >= beforeFrom && e.week < since.slice(0, 10));
  const following = followingLine({weeks, entries, before});

  const {headline, text} = render({since, until, weeks, min, runs: counts, parsed, affirms, live, inBlock, following});
  writeFileSync(out, text, {mode: 0o600});
  mkdirSync(dirname(followingFile), {recursive: true});
  writeFileSync(followingFile, JSON.stringify(upsertFollowing(kept, entries, until), null, 2) + '\n', {mode: 0o600});
  console.log(headline);
  console.log(`\nweeks: ${entries.map(e => `${e.week} ${e.complaints_in_block} of ${e.sessions} sessions`).join(' · ')}`);
  console.log(`written to ${out} and ${followingFile}`);
}

// Compared through realpath: node runs the real file, so under a linked path
// such as /var the two names differ and main would silently never run.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
