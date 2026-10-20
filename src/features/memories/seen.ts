// When this browser last opened each scope's book, so the book can say what
// came in since. Per browser on purpose for now: it is a convenience, and a
// missing value only means the note does not show.
const KEY = 'satchel.book.seen';

function all(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
}

export function lastSeen(scope: string): string | null {
  return all()[scope] ?? null;
}

export function markSeen(scope: string, at = new Date().toISOString()) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...all(), [scope]: at })); }
  catch { /* The note just will not show next time. */ }
}
