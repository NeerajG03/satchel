// Scores the pass against memories a labeller wrote down for real
// conversations. Nothing here knows about models or files.
//
// A gold memory is found when some change the pass made states it: every
// keyword appears in the statement (as a stem, so "subagent" finds
// "subagents") and the topic agrees. Keywords are the labeller's, chosen
// without seeing what the pass wrote, so this is a check on meaning that costs
// no model call. It undercounts when the pass words a real memory in a way the
// keywords did not expect, which is why the changes that matched nothing are
// listed for a person to read rather than counted as wrong.

const text = value => String(value ?? '').toLowerCase();
const slug = value => (!value || value === 'personal') ? null : value;

/** Changes that state a claim; a bare affirm or retire carries no statement. */
const claims = changes => changes.filter(c => ['add', 'extend', 'replace'].includes(c.action) && c.statement);

export function found(gold, change) {
  const statement = text(change.statement);
  return (gold.keywords ?? []).length > 0 && gold.keywords.every(k => statement.includes(text(k)));
}

/** @returns per gold memory whether it was found and filed under the right
 *  topic, and the pass's claims that matched no gold memory. */
export function scoreSession(goldMemories, changes) {
  const made = claims(changes);
  const used = new Set();
  const rows = goldMemories.map(gold => {
    const index = made.findIndex((c, i) => !used.has(i) && found(gold, c));
    if (index >= 0) used.add(index);
    return {gold, found: index >= 0, topic: index >= 0 && slug(made[index].topic) === slug(gold.topic)};
  });
  return {rows, extra: made.filter((_, i) => !used.has(i))};
}

/** Pairs a judge found between claims that matched nothing and gold memories
 *  that were not found: [{gold: index into rows, claim: index into extra}].
 *  Keywords are cheap and strict; this is the second look at what they missed. */
export function applyMatches(result, pairs) {
  const rows = result.rows.map(r => ({...r}));
  const taken = new Set();
  for (const {gold, claim} of pairs) {
    const row = rows[gold];
    const change = result.extra[claim];
    if (!row || row.found || !change || taken.has(claim)) continue;
    taken.add(claim);
    row.found = true;
    row.judged = true;
    row.topic = slug(change.topic) === slug(row.gold.topic);
  }
  return {rows, extra: result.extra.filter((_, i) => !taken.has(i))};
}

/** Totals over every session. `quiet` sessions are those whose gold is empty:
 *  anything the pass writes there is noise unless a person says otherwise. */
export function summarise(sessions) {
  const all = sessions.flatMap(s => s.rows);
  const clear = all.filter(r => r.gold.confidence !== 'arguable');
  const count = rows => ({found: rows.filter(r => r.found).length, total: rows.length});
  const quiet = sessions.filter(s => !s.rows.length);
  return {
    all: count(all), clear: count(clear),
    topic: {right: all.filter(r => r.found && r.topic).length, of: all.filter(r => r.found).length},
    extra: sessions.reduce((sum, s) => sum + s.extra.length, 0),
    quiet: {noisy: quiet.filter(s => s.extra.length).length, total: quiet.length},
  };
}
