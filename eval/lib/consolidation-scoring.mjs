// Scoring one consolidation case. Pure, so it can be tested without a model.
//
// The harness decides whether a prompt change ships, so its arithmetic is
// worth testing directly, the same reason eval/lib/metrics.mjs is.
//
// Three things make this different from scoring the router.
//
// There are five outcomes rather than two, and four of them name an existing
// memory, so "right" includes hitting the right target.
//
// A mistake can be destructive. Retiring a standing fact or replacing a
// memory nobody mentioned is not a miss, it is damage, and averaging it into
// an accuracy number is how it stops being visible. It is counted separately
// and the bar for it is zero rather than "better than before".
//
// And the two halves have to be read together, the same way the router's
// bench reads quiet against kept. Restraint is trivially won by changing
// nothing and action is trivially won by changing everything, so neither
// number means anything on its own.

/** Is the claim in what came back.
 *
 *  Containment against the shorter side, not symmetric overlap: the question
 *  is only "is the wanted claim in this statement", and the symmetric version
 *  fails a correct answer for being longer. Copied deliberately from
 *  router-rigour rather than shared, because the two benches should be free to
 *  disagree about matching without one silently changing the other. */
export function contains(got, want) {
  const words = t => new Set(String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const x = words(got), y = words(want);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

const ENDS = new Set(['replace', 'retire']);

/** Which changes ended a memory the case did not sanction.
 *
 *  Ending is the only thing here that cannot be undone by the next run: an add
 *  that should not exist is one row to delete, and a memory that was retired
 *  stops loading until a person goes and finds it. */
export function damage(changes, expect) {
  const allowed = expect && expect !== 'either' && ENDS.has(expect.action) ? expect.target : null;
  return changes
    .filter(change => ENDS.has(change.action) && change.target !== allowed)
    .map(change => ({action: change.action, target: change.target}));
}

/** Did the pass do what the case asked, and if not, what went wrong.
 *
 *  `changes` are post-validation, because that is what reaches the database.
 *  A statement the model invented and validation dropped is not a memory and
 *  must not be scored as one; `dropped` is reported separately so a wording
 *  that produces unusable output is still visible. */
export function score(item, changes) {
  const harm = damage(changes, item.expect);
  const forbidden = (item.forbid ?? []).find(bad =>
    changes.some(c => String(c.statement ?? '').toLowerCase().includes(bad.toLowerCase())));
  if (item.expect === 'either') return {scored: false, harm};

  const want = item.expect;
  if (want.action === 'nothing') {
    return {scored: true, ok: changes.length === 0, harm,
      note: changes.length ? `${changes[0].action} "${String(changes[0].statement ?? '').slice(0, 56)}"` : ''};
  }
  if (forbidden) return {scored: true, ok: false, harm, note: `kept the rejected premise: "${forbidden}"`};

  const matching = changes.filter(c => c.action === want.action);
  if (!matching.length) {
    return {scored: true, ok: false, harm,
      note: changes.length ? `wanted ${want.action}, got ${changes.map(c => c.action).join('+')}`
        : `wanted ${want.action}, changed nothing`};
  }
  // Exactly one change, not at least one. A pass that does the right thing and
  // three other things has not done the right thing: every extra row is one a
  // person has to read and decide about.
  if (changes.length > 1) {
    return {scored: true, ok: false, harm,
      note: `${want.action} plus ${changes.length - 1} more: ${changes.map(c => c.action).join('+')}`};
  }
  const change = matching[0];
  if (want.target != null && change.target !== want.target) {
    return {scored: true, ok: false, harm, note: `targeted #${change.target ?? 'none'}, wanted #${want.target}`};
  }
  if (want.want && contains(change.statement, want.want) < 0.5) {
    return {scored: true, ok: false, harm, note: `drifted: "${String(change.statement).slice(0, 56)}"`};
  }
  if ('scope' in want && (change.project ?? null) !== (want.scope ?? null)) {
    return {scored: true, ok: false, harm,
      note: `scope ${change.project ?? 'personal'}, wanted ${want.scope ?? 'personal'}`};
  }
  if (want.expires && !change.expires) {
    return {scored: true, ok: false, harm, note: 'no expiry, and the user gave one'};
  }
  // A relative reference frozen into a permanent claim is the failure this
  // checks for. "Next Friday" means nothing in six months; a date does.
  if (want.resolved && /\b(next|last|this)\s+(week|month|friday|monday|tuesday|wednesday|thursday|saturday|sunday|year)\b|\btomorrow\b|\byesterday\b|\bthis time around\b/i.test(change.statement)) {
    return {scored: true, ok: false, harm, note: `unresolved: "${String(change.statement).slice(0, 56)}"`};
  }
  return {scored: true, ok: true, harm, note: ''};
}

/** Which half of the headline a case belongs to, read off the case itself.
 *
 *  This was a hand-kept list of categories and it was wrong within the hour:
 *  `churn` has a case that should change something and a case that should not,
 *  because the marker is a reason to look rather than a verdict. Deriving it
 *  from the expectation cannot drift, and a category is free to sit on both
 *  sides, which is what an honest one does. */
export const isRestraint = expect =>
  expect !== 'either' && expect?.action === 'nothing';

/** Restraint is trivially won by changing nothing and action by changing
 *  everything, so the two are counted apart and printed together. Damage is
 *  counted over every case including the ones nobody scored: "both answers are
 *  defensible" never includes ending a third memory. */
export function summarise(rows) {
  const byCategory = new Map();
  let restraintRight = 0, restraintTotal = 0, actionRight = 0, actionTotal = 0, harm = 0;
  for (const row of rows) {
    harm += row.harm.length;
    if (!row.scored) continue;
    const tally = byCategory.get(row.category) ?? {right: 0, total: 0};
    tally.total++; if (row.ok) tally.right++;
    byCategory.set(row.category, tally);
    if (row.restraint) { restraintTotal++; if (row.ok) restraintRight++; }
    else { actionTotal++; if (row.ok) actionRight++; }
  }
  return {byCategory, harm,
    restraint: {right: restraintRight, total: restraintTotal},
    action: {right: actionRight, total: actionTotal},
    both: {right: restraintRight + actionRight, total: restraintTotal + actionTotal}};
}
