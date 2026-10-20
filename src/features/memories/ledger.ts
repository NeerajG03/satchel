import type { MemorySummary } from './model';

export type Why = 'new' | 'again' | 'changed';
export type Change = { at: string; why: Why };
export type Day = 'today' | 'yesterday' | 'week' | 'older';
export type Group<T> = { day: Day; items: T[]; counts: Record<Why, number> };

// Only for rows older than the event log. A said-again that also flips a
// picked-up memory to said writes affirmed_at with now() and updated_at with
// clock_timestamp() a moment later, in one statement.
const SAME = 2_000;
const DAY = 86_400_000;
const EVENT_WHY: Record<string, Why> = { added: 'new', confirmed: 'again' };

/** Why a row sits where it does. The last event says what the last real
 *  change was. Being said again writes no event, only affirmed_at, and the
 *  event and affirmed_at share a transaction's now(), so an affirmed_at past
 *  the event means it was said again since. */
export function changeOf(memory: MemorySummary): Change {
  const created = Date.parse(memory.created_at ?? memory.updated_at);
  const updated = Date.parse(memory.updated_at);
  const affirmed = Date.parse(memory.affirmed_at ?? memory.updated_at);
  const at = new Date(Math.max(created, updated, affirmed)).toISOString();
  if (memory.last_change && memory.last_change_at) {
    if (affirmed > Date.parse(memory.last_change_at)) return { at, why: 'again' };
    return { at, why: EVENT_WHY[memory.last_change] ?? 'changed' };
  }
  if (Date.parse(at) - created <= SAME) return { at, why: 'new' };
  if (affirmed - updated > SAME) return { at, why: 'again' };
  return { at, why: 'changed' };
}

/** Whether the row carries the dates that make its tag mean anything. */
export const dated = (memory: MemorySummary) => Boolean(memory.created_at);

function startOfDay(now: number): number {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return start.getTime();
}

export function dayOf(iso: string, now = Date.now()): Day {
  const start = startOfDay(now);
  const then = Date.parse(iso);
  if (then >= start) return 'today';
  if (then >= start - DAY) return 'yesterday';
  if (then >= start - 6 * DAY) return 'week';
  return 'older';
}

/** For the time column: as short as it can be and still be read alone. A
 *  weekday inside the last seven days, the same days the book groups, and a
 *  date before that. */
export function shortWhen(iso: string, now = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} min`;
  const day = dayOf(iso, now);
  if (day === 'today') return `${Math.floor(diff / 3_600_000)} h`;
  const then = new Date(iso);
  if (day === 'older') return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return then.toLocaleDateString(undefined, { weekday: 'short' });
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

/** The newest change among these rows, in the database's clock. */
export function newestChange(memories: MemorySummary[]): string {
  return memories.reduce((latest, memory) => {
    const at = changeOf(memory).at;
    return at > latest ? at : latest;
  }, new Date(0).toISOString());
}

/** What came in after `seen` and up to `until`, both in the database's clock.
 *  Only new memories are listed; the rest that moved are a count, because a
 *  re-said rule is not news. Rows without their dates are left out, because
 *  they cannot tell a new memory from an edited one. */
export function sinceLast<T extends MemorySummary>(memories: T[], seen: string | null, until: string) {
  if (!seen) return { fresh: [] as T[], moved: 0 };
  const fresh: { memory: T; at: string }[] = [];
  let moved = 0;
  for (const memory of memories) {
    if (!dated(memory)) continue;
    const change = changeOf(memory);
    if (change.at <= seen || change.at > until) continue;
    if (change.why === 'new') fresh.push({ memory, at: change.at }); else moved += 1;
  }
  fresh.sort((a, b) => b.at.localeCompare(a.at));
  return { fresh: fresh.map(item => item.memory), moved };
}
