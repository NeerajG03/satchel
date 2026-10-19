// How what reached the agent compares with what a blind labeller says should
// have. Pure, so tests/injection-eval.test.mjs checks the arithmetic without a
// transcript or a vector.
//
// A moment is one prompt. The replay (or production) fills in:
//   shown    ids in the prompt block
//   before   ids already in front of the agent: the start block and earlier
//            prompt blocks since the last compact or clear
//   loaded   ids a start block put in front since the previous scored prompt;
//            charged here, because this is the first prompt that paid for them
//   ahead    ids any typed prompt from this one to the next reset needed, from
//            aheadNeeds(); a loaded row that is in it earned its room
//   active   the topic the session was scoped to, or null
//   tokens   the prompt block's estimated tokens
//   ended    ids shown that had been ended by then (production only)
// The gold, for a typed prompt, is {must, helps, traps, topic}, as of that
// prompt's own time (asOf below).
//
// No number is read alone. Showing nothing wins clean and quiet and loses
// reached; showing everything does the reverse. Harmful is not a rate and is
// never averaged into anything: a trap or an ended memory shown is a wrong
// instruction handed to the agent, and the bar is zero.

import {time as instant} from './injection-twin.mjs';

const share = (a, b) => b ? a / b : null;
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };

/** The gold as it stood at `ts`. The labeller read today's memory set, so a
 *  label can name a row that was written after the prompt ran; nothing could
 *  have shown it, and it is dropped. A row ended by then is a trap, as today.
 *  A prompt whose every need is dropped comes back null: unlabelled, not
 *  quiet, since the labeller said it needed something. */
export function asOf(gold, ts, byId) {
  if (!gold) return null;
  const at = instant(ts);
  const existed = id => { const m = byId.get(id); return !m?.created_at || instant(m.created_at) <= at; };
  const ended = id => { const m = byId.get(id); return Boolean(m?.ended_at) && instant(m.ended_at) <= at; };
  const must = (gold.must ?? []).filter(existed), helps = (gold.helps ?? []).filter(existed);
  const dropped = (gold.must ?? []).length + (gold.helps ?? []).length - must.length - helps.length;
  if (dropped && !must.length && !helps.length) return null;
  const traps = [...(gold.traps ?? []), ...must.filter(ended), ...helps.filter(ended)];
  return {...gold, must: must.filter(id => !ended(id)), helps: helps.filter(id => !ended(id)), traps};
}

/** Fills in `ahead` on each moment: what any typed prompt from it to the next
 *  reset needed. Moments come in session order; `resetBefore` marks one that
 *  followed a startup, clear or compact. A block serves the whole stretch, so
 *  a loaded row is judged on the stretch, not on the one prompt it landed on. */
export function aheadNeeds(moments) {
  const bySession = new Map();
  for (const m of moments) { const key = m.session ?? ''; if (!bySession.has(key)) bySession.set(key, []); bySession.get(key).push(m); }
  const out = new Map();
  for (const run of bySession.values()) {
    let needs = new Set();
    for (let i = run.length - 1; i >= 0; i--) {
      const m = run[i];
      if (m.typed && m.gold) for (const id of [...(m.gold.must ?? []), ...(m.gold.helps ?? [])]) needs.add(id);
      out.set(m, [...needs]);
      if (m.resetBefore) needs = new Set();
    }
  }
  return moments.map(m => ({...m, ahead: out.get(m)}));
}

/** One moment's verdicts. */
export function scoreMoment(moment) {
  const shown = moment.shown ?? [];
  const loaded = moment.loaded ?? [];
  const before = new Set(moment.before ?? []);
  const front = new Set([...before, ...shown]);
  const repeats = shown.filter(id => before.has(id)).length;
  const gold = moment.gold;
  if (!moment.typed || !gold) return {id: moment.id, typed: Boolean(moment.typed), labelled: false,
    slots: shown.length, repeats, quiet: shown.length === 0, tokens: moment.tokens ?? 0,
    harmful: (moment.ended ?? []).length};
  const must = gold.must ?? [], helps = gold.helps ?? [], traps = new Set(gold.traps ?? []);
  const graded = new Set([...must, ...helps]);
  const useful = shown.filter(id => graded.has(id)).length;
  const harmful = shown.filter(id => traps.has(id)).length + (moment.ended ?? []).length;
  const answerable = graded.size > 0;
  const mustReached = must.filter(id => front.has(id)).length;
  const helpsReached = helps.filter(id => front.has(id)).length;
  // The headline per moment. An answerable prompt scores how much of what it
  // needed was in front of the agent, weighted 2 to 1, times how much of the
  // prompt block was worth its room. A prompt that needed nothing scores 1 for
  // silence and 0 for anything at all. Same idea as utility in metrics.mjs.
  const weight = 2 * must.length + helps.length;
  const reachedWeighted = weight ? (2 * mustReached + helpsReached) / weight : 0;
  const penalty = harmful ? 0.5 : 1;
  const precision = shown.length ? useful / shown.length : 1;
  const utilityFree = answerable ? reachedWeighted * precision * penalty : (shown.length ? 0 : 1);
  // The charged value: the start block's rows take room too. They are charged
  // on the first prompt scored after they loaded and earn it when any prompt
  // in that stretch of the session needed them. A quiet prompt that follows a
  // block is judged on the block alone.
  const ahead = new Set(moment.ahead ?? graded);
  const blockUseful = loaded.filter(id => ahead.has(id)).length;
  const charged = shown.length + loaded.length;
  const precisionCharged = charged ? (useful + blockUseful) / charged : 1;
  const utility = answerable ? reachedWeighted * precisionCharged * penalty
    : shown.length ? 0 : (loaded.length ? blockUseful / loaded.length : 1);
  return {id: moment.id, typed: true, labelled: true, answerable,
    must: must.length, mustReached, helps: helps.length, helpsReached,
    slots: shown.length, useful, repeats, harmful, quiet: shown.length === 0, tokens: moment.tokens ?? 0,
    blockRows: loaded.length, blockUseful,
    topicRight: gold.topic === undefined ? null : (gold.topic ?? null) === (moment.active ?? null),
    utility, utilityFree};
}

/** The scorecard. */
export function summarise(moments) {
  const rows = moments.map(scoreMoment);
  const typed = rows.filter(r => r.labelled);
  const host = rows.filter(r => !r.typed);
  const sum = (xs, key) => xs.reduce((a, r) => a + (r[key] ?? 0), 0);
  const slots = sum(rows, 'slots');
  const typedSlots = sum(typed, 'slots');
  const quietOnes = typed.filter(r => !r.answerable);
  const topicRows = typed.filter(r => r.topicRight !== null);
  return {
    moments: rows.length, typed: typed.length, host: host.length,
    answerable: typed.filter(r => r.answerable).length,
    reached: share(sum(typed, 'mustReached'), sum(typed, 'must')),
    helpsReached: share(sum(typed, 'helpsReached'), sum(typed, 'helps')),
    clean: share(sum(typed, 'useful'), typedSlots),
    quiet: share(quietOnes.filter(r => r.quiet).length, quietOnes.length),
    hostQuiet: share(host.filter(r => r.quiet).length, host.length),
    repeat: share(sum(rows, 'repeats'), slots),
    topicRight: share(topicRows.filter(r => r.topicRight).length, topicRows.length),
    tokens: median(rows.filter(r => r.slots).map(r => r.tokens)),
    slots, harmful: sum(rows, 'harmful'),
    blockRows: sum(typed, 'blockRows'),
    blockUseful: share(sum(typed, 'blockUseful'), sum(typed, 'blockRows')),
    utility: share(sum(typed, 'utility'), typed.length),
    utilityFree: share(sum(typed, 'utilityFree'), typed.length),
    rows,
  };
}

/** Per-moment utilities in a fixed order, for a paired comparison with a
 *  baseline that holds the same ids. Moments either side lacks are dropped and
 *  counted, so a grown golden set does not read as a change in the code. */
export function pair(current, baseline) {
  const was = new Map((baseline ?? []).map(r => [r.id, r.utility]));
  const now = current.filter(r => r.labelled && was.has(r.id));
  return {a: now.map(r => r.utility), b: now.map(r => was.get(r.id)), compared: now.length,
    unmatched: current.filter(r => r.labelled && !was.has(r.id)).length};
}

/** The two sides of one per-moment number, for paired(), on the moments both
 *  runs scored it. A moment one side did not score (the labeller's needs did
 *  not exist yet, so its value is null or missing) is left out: one null minus
 *  a number is NaN, and one NaN turns the whole delta into NaN, which is how a
 *  change of exactly zero once printed as `NaN` instead of `0.000`. */
export function sides(current, baseline, key) {
  const number = v => typeof v === 'number' && Number.isFinite(v);
  const was = new Map((baseline ?? []).filter(r => number(r[key])).map(r => [r.id, r[key]]));
  const now = current.filter(r => number(r[key]) && was.has(r.id));
  return {a: now.map(r => r[key]), b: now.map(r => was.get(r.id)), compared: now.length};
}

/** Whether a baseline can gate this run. One taken on another snapshot
 *  measured another memory set; one scored with another ruler measured the
 *  same prompts another way. Either difference would be the measure moving,
 *  not the code, so main is scored again first. */
export function comparable(baseline, {snapshot, method}) {
  if (!baseline) return {ok: false, reason: null};
  if (baseline.snapshot !== snapshot)
    return {ok: false, reason: `the baseline is from the ${String(baseline.snapshot).slice(0, 16)} snapshot, not this one`};
  if (baseline.method !== method)
    return {ok: false, reason: `the baseline was scored the old way (${baseline.method ?? 'before as-of'}; this run is ${method})`};
  return {ok: true, reason: null};
}

/** Whether a change may merge, against the baseline scorecard. */
export function gate(now, base, significance) {
  const reasons = [];
  if (base.reached != null && now.reached != null && now.reached < base.reached - 0.02)
    reasons.push(`reached fell ${((base.reached - now.reached) * 100).toFixed(1)} points`);
  if (now.harmful > base.harmful) reasons.push(`harmful shown rose from ${base.harmful} to ${now.harmful}`);
  if (significance?.significant && significance.delta < 0) reasons.push('utility fell beyond chance');
  return {pass: reasons.length === 0, reasons};
}

/** Real-sessions moments either side of a cut, by each prompt's own time, so
 *  the scorecard can show what people get since a plugin or server fix shipped
 *  apart from what older code gave them. A moment with no readable time cannot
 *  be shown to be after the cut and goes in `before`. Run after aheadNeeds(),
 *  so a block row is still judged on its whole stretch. */
export function splitAt(moments, cut) {
  const at = instant(cut);
  if (!Number.isFinite(at)) throw new Error(`not a date: ${cut}`);
  const since = [], before = [];
  for (const m of moments) (instant(m.ts) >= at ? since : before).push(m);
  return {since, before};
}
