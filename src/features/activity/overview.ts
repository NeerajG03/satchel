// The overview at the top of the Activity page.
//
// Four questions that used to take a database query each: what would the
// button read, are the models answering, is the schedule on, and what does
// the memory set hold.

/** A session with turns no pass has read yet, as pending_documents gives it. */
export type WaitingDoc = {
  id: string; session_key: string; project_id: string | null; turns: number; chars: number;
  last_turn_at: string; consolidated_through: number | null;
};
/** The button reads a session once it has been quiet this long, which is the
 *  same 30 minutes consolidate() sends as idle_minutes. */
export const IDLE_MINUTES = 30;
export function splitWaiting(docs: WaitingDoc[], now = Date.now(), idle = IDLE_MINUTES) {
  const quiet = (doc: WaitingDoc) => now - Date.parse(doc.last_turn_at) >= idle * 60000;
  return { ready: docs.filter(quiet), active: docs.filter(doc => !quiet(doc)) };
}

/** When the free Gemini quota last reset: midnight in California, which is
 *  12:30 or 13:30 in India depending on the time of year. Worked out rather
 *  than written down, so it stays right when the clocks change. */
export function quotaDayStart(now = Date.now()): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(now)).map(part => [part.type, Number(part.value)]));
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = asIfUtc - Math.floor(now / 1000) * 1000;
  return Date.UTC(parts.year, parts.month - 1, parts.day) - offset;
}

/** One logged model call, from either run log. */
export type ModelCall = { model: string; error: string | null; created_at: string; source: 'capture' | 'consolidation' };
export type ModelHealth = {
  model: string; calls: number; answered: number; failed: number;
  last: ModelCall; lastError: string | null; state: 'answering' | 'quota' | 'failing';
};
/** A spent daily quota and a model that is failing for any other reason are
 *  different afternoons: one comes back at the reset, the other needs someone
 *  to look. So they get different words. */
export const isQuota = (error: string | null) => !!error && /quota|rate limit|429/i.test(error);
export function modelHealth(calls: ModelCall[]): ModelHealth[] {
  const by = new Map<string, ModelCall[]>();
  for (const call of calls) by.set(call.model, [...(by.get(call.model) ?? []), call]);
  return [...by].map(([model, list]) => {
    const sorted = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const failed = sorted.filter(call => call.error);
    const last = sorted[0];
    const state = !last.error ? 'answering' as const : isQuota(last.error) ? 'quota' as const : 'failing' as const;
    return { model, calls: sorted.length, answered: sorted.length - failed.length, failed: failed.length,
      last, lastError: failed[0]?.error ?? null, state };
  }).sort((a, b) => b.last.created_at.localeCompare(a.last.created_at));
}

/** The schedule, as consolidation_status() gives it. No row means it was never
 *  switched on. */
export type ScheduleStatus = {
  enabled: boolean; endpoint: string; idle_minutes: number; last_run_at: string | null;
  last_status: number | null; last_error: string | null; failures: number; scheduled: boolean;
};

/** A live memory, just the columns the tally needs. */
export type LiveMemory = { project_id: string | null; band: string; kind: string };
export function memorySet(rows: LiveMemory[], slugs: Map<string, string>) {
  const scopes = new Map<string, number>();
  for (const row of rows) {
    const scope = row.project_id === null ? 'personal' : slugs.get(row.project_id) ?? 'a project';
    scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
  }
  return {
    live: rows.length,
    heard: rows.filter(row => row.band === 'heard').length,
    scopes: [...scopes].sort((a, b) => b[1] - a[1]),
    kinds: (['preference', 'fact', 'intent'] as const)
      .map(kind => [kind, rows.filter(row => row.kind === kind).length] as const),
  };
}

/** Everything the overview reads, in one answer. */
export type Overview = {
  waiting: WaitingDoc[]; schedule: ScheduleStatus | null; calls: ModelCall[];
  /** The newest call from either log, whenever it was, so a quiet day can say
   *  how long it has been quiet. */
  lastCall: ModelCall | null;
  since: number; memories: LiveMemory[]; slugs: Map<string, string>;
};
