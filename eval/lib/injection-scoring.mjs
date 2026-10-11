// How what reached the agent compares with what a blind labeller says should
// have. Pure, so tests/injection-eval.test.mjs checks the arithmetic without a
// transcript or a vector.
//
// A moment is one prompt. The replay (or production) fills in:
//   shown    ids in the prompt block
//   before   ids already in front of the agent: the start block and earlier
//            prompt blocks since the last compact or clear
//   active   the topic the session was scoped to, or null
//   tokens   the prompt block's estimated tokens
//   ended    ids shown that had been ended by then (production only)
// The gold, for a typed prompt, is {must, helps, traps, topic}.
//
// No number is read alone. Showing nothing wins clean and quiet and loses
// reached; showing everything does the reverse. Harmful is not a rate and is
// never averaged into anything: a trap or an ended memory shown is a wrong
// instruction handed to the agent, and the bar is zero.

const share = (a, b) => b ? a / b : null;
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };

/** One moment's verdicts. */
export function scoreMoment(moment) {
  const shown = moment.shown ?? [];
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
  const precision = shown.length ? useful / shown.length : 1;
  const utility = answerable ? reachedWeighted * precision * (harmful ? 0.5 : 1) : (shown.length ? 0 : 1);
  return {id: moment.id, typed: true, labelled: true, answerable,
    must: must.length, mustReached, helps: helps.length, helpsReached,
    slots: shown.length, useful, repeats, harmful, quiet: shown.length === 0, tokens: moment.tokens ?? 0,
    topicRight: gold.topic === undefined ? null : (gold.topic ?? null) === (moment.active ?? null),
    utility};
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
    utility: share(sum(typed, 'utility'), typed.length),
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

/** Whether a change may merge, against the baseline scorecard. */
export function gate(now, base, significance) {
  const reasons = [];
  if (base.reached != null && now.reached != null && now.reached < base.reached - 0.02)
    reasons.push(`reached fell ${((base.reached - now.reached) * 100).toFixed(1)} points`);
  if (now.harmful > base.harmful) reasons.push(`harmful shown rose from ${base.harmful} to ${now.harmful}`);
  if (significance?.significant && significance.delta < 0) reasons.push('utility fell beyond chance');
  return {pass: reasons.length === 0, reasons};
}
