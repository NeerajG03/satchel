// When this browser last opened the book, so the book can say what came in
// since. Per browser on purpose for now: it is a convenience, and a missing
// value only means the note does not show.
//
// `at` is the newest change the book had then, in the database's clock, and is
// what new rows are compared with. `visited` is the browser's own time and is
// only ever shown.
const KEY = 'satchel.book.seen';
// The note covers every topic, so one mark covers the whole book. Before that
// there was one mark per scope, and "For me" is the one most people had.
const WHOLE = 'all';
const BEFORE = 'personal';
export type Seen = { at: string; visited: string };

function all(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
}

function read(value: unknown): Seen | null {
  const seen = value as Partial<Seen> | undefined;
  return typeof seen?.at === 'string' && typeof seen.visited === 'string' ? { at: seen.at, visited: seen.visited } : null;
}

export function bookSeen(): Seen | null {
  const stored = all();
  return read(stored[WHOLE]) ?? read(stored[BEFORE]);
}

export function markBookSeen(at: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ [WHOLE]: { at, visited: new Date().toISOString() } })); }
  catch { /* The note just will not show next time. */ }
}
