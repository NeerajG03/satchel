import type { MemorySummary } from './model';

export type Why = 'new' | 'again' | 'changed';
export type Change = { at: string; why: Why };
export type Day = 'today' | 'yesterday' | 'week' | 'older';
export type Group<T> = { day: Day; items: T[]; counts: Record<Why, number> };

// A said-again that also flips a picked-up memory to said writes affirmed_at
// with now() and updated_at with clock_timestamp() a moment later, in one
// statement. Without some slack those read as two separate events.
const SAME = 2_000;
const DAY = 86_400_000;

/** Why a row sits where it does. updated_at is the last time the wording or
 *  band changed and affirmed_at the last time it was said, so creation, a
 *  change and a re-say each leave a different pair of dates. A correction and
 *  the first re-say of a picked-up memory move both together, so both read as
 *  changed. */
export function changeOf(memory: MemorySummary): Change {
  const created = Date.parse(memory.created_at ?? memory.updated_at);
  const updated = Date.parse(memory.updated_at);
  const affirmed = Date.parse(memory.affirmed_at ?? memory.updated_at);
  const latest = Math.max(created, updated, affirmed);
  const at = new Date(latest).toISOString();
  if (latest - created <= SAME) return { at, why: 'new' };
  if (affirmed - updated > SAME) return { at, why: 'again' };
  return { at, why: 'changed' };
}

export function dayOf(iso: string, now = Date.now()): Day {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const then = Date.parse(iso);
  if (then >= start.getTime()) return 'today';
  if (then >= start.getTime() - DAY) return 'yesterday';
  if (then >= start.getTime() - 6 * DAY) return 'week';
  return 'older';
}

const ORDER: Day[] = ['today', 'yesterday', 'week', 'older'];

/** Newest change first, cut into days. Empty days are left out. */
export function byDay<T extends MemorySummary>(memories: T[], now = Date.now()): Group<T>[] {
  const changed = memories.map(memory => ({ memory, change: changeOf(memory) }))
    .sort((a, b) => b.change.at.localeCompare(a.change.at) || a.memory.id.localeCompare(b.memory.id));
  const groups = new Map<Day, Group<T>>();
  for (const { memory, change } of changed) {
    const day = dayOf(change.at, now);
    const group = groups.get(day) ?? { day, items: [], counts: { new: 0, again: 0, changed: 0 } };
    group.items.push(memory);
    group.counts[change.why] += 1;
    groups.set(day, group);
  }
  return ORDER.flatMap(day => groups.get(day) ?? []);
}

/** What came in between the last visit and this one. Only new memories are
 *  listed; the rest that moved are a count, because a re-said rule is not
 *  news. Anything after `until` happened while you were looking, so it is not
 *  news either. */
export function sinceLast<T extends MemorySummary>(memories: T[], seen: string | null, until = new Date().toISOString()) {
  if (!seen) return { fresh: [] as T[], moved: 0 };
  const after = (iso: string) => iso > seen && iso <= until;
  const fresh: T[] = [];
  let moved = 0;
  for (const memory of memories) {
    const change = changeOf(memory);
    if (!after(change.at)) continue;
    if (change.why === 'new') fresh.push(memory); else moved += 1;
  }
  fresh.sort((a, b) => changeOf(b).at.localeCompare(changeOf(a).at));
  return { fresh, moved };
}
