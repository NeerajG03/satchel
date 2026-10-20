import type { MemorySummary } from './model';

export type Why = 'new' | 'again' | 'changed';
export type Change = { at: string; why: Why };
export type Day = 'today' | 'yesterday' | 'week' | 'older';
export type Group<T> = { day: Day; items: T[]; counts: Record<Why, number> };

// Only for rows older than the event log. A said-again that also flips a
// picked-up memory to said writes affirmed_at with now() and updated_at with
// clock_timestamp() a moment later, in one statement.
const SAME = 2_000;
// The overnight run adds a memory and confirms it a couple of minutes later
// when it was said more than once. Anything that happens to a memory this
// soon after it was made is part of making it.
const PASS = 10 * 60_000;
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
  if (Date.parse(at) - created <= PASS) return { at, why: 'new' };
  if (memory.last_change && memory.last_change_at) {
    if (affirmed > Date.parse(memory.last_change_at)) return { at, why: 'again' };
    return { at, why: EVENT_WHY[memory.last_change] ?? 'changed' };
  }
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

type Ended = { topic_id: string | null; ended_at: string | null };

/** The newest change among these rows, in the database's clock, counting
 *  memories that were put in the archive. */
export function newestChange(memories: MemorySummary[], ended: Ended[] = []): string {
  const times = [...memories.map(memory => Date.parse(changeOf(memory).at)),
    ...ended.flatMap(row => row.ended_at ? [Date.parse(row.ended_at)] : [])];
  return new Date(Math.max(0, ...times)).toISOString();
}

export type TopicNews<T> = { topicId: string | null; fresh: T[]; again: T[]; changed: T[]; archived: number };

/** What came in after `seen` and up to `until`, both in the database's clock,
 *  one entry per topic with anything in it, the busiest first. New means made
 *  in that window. Rows without their dates are left out, because they cannot
 *  tell a new memory from an edited one. */
export function newsByTopic<T extends MemorySummary>(memories: T[], ended: Ended[], seen: string | null, until: string): TopicNews<T>[] {
  if (!seen) return [];
  const from = Date.parse(seen), to = Date.parse(until);
  const inside = (iso: string | null | undefined) => {
    const at = iso ? Date.parse(iso) : NaN;
    return at > from && at <= to;
  };
  const topics = new Map<string | null, TopicNews<T>>();
  const entry = (topicId: string | null) => {
    const found = topics.get(topicId) ?? { topicId, fresh: [], again: [], changed: [], archived: 0 };
    topics.set(topicId, found);
    return found;
  };
  const sorted = memories.filter(dated).map(memory => ({ memory, change: changeOf(memory) }))
    .sort((a, b) => b.change.at.localeCompare(a.change.at));
  for (const { memory, change } of sorted) {
    if (inside(memory.created_at)) entry(memory.topic_id).fresh.push(memory);
    else if (inside(change.at)) entry(memory.topic_id)[change.why === 'again' ? 'again' : 'changed'].push(memory);
  }
  for (const row of ended) if (inside(row.ended_at)) entry(row.topic_id).archived += 1;
  const size = (news: TopicNews<T>) => news.again.length + news.changed.length + news.archived;
  return [...topics.values()].sort((a, b) => b.fresh.length - a.fresh.length || size(b) - size(a));
}
