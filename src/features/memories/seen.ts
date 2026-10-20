// When this browser last opened each scope's book, so the book can say what
// came in since. Per browser on purpose for now: it is a convenience, and a
// missing value only means the note does not show.
//
// `at` is the newest change the book had then, in the database's clock, and is
// what new rows are compared with. `visited` is the browser's own time and is
// only ever shown.
const KEY = 'satchel.book.seen';
export type Seen = { at: string; visited: string };

function all(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
}

export function lastSeen(scope: string): Seen | null {
  const value = all()[scope] as Partial<Seen> | undefined;
  return typeof value?.at === 'string' && typeof value.visited === 'string' ? { at: value.at, visited: value.visited } : null;
}

export function markSeen(scope: string, at: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...all(), [scope]: { at, visited: new Date().toISOString() } })); }
  catch { /* The note just will not show next time. */ }
}
