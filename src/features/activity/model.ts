// What Satchel did, as one list.
//
// Six tables answer six different questions and none of them answers "what
// happened". A memory that arrived wrong could have come from a bad retrieval,
// a bad capture, a bad consolidation or a document that was never written, and
// telling those apart meant four queries and a timestamp comparison done by
// hand. So they are folded into one stream, in the order they happened.
//
// Every row keeps its own shape under `detail`. A summary that flattened them
// into a common set of fields would be a fifth thing to keep in sync with the
// four it describes.

import { count } from '../../app/format';

export type ActivityKind = 'session' | 'prompt' | 'capture' | 'consolidation' | 'document' | 'memory';

export type Injection = {
  id: string; session_key: string; event: string; query: string | null;
  memory_ids: string[]; matched: number; in_scope: number; tokens: number; created_at: string;
};
// prompt and response are absent in the feed and fetched when a row is
// opened. They are whole model prompts, capped at 40,000 and 200,000
// characters, and selecting them to render "kept 0, dropped 0" is the mistake
// list_memories exists to prevent.
export type RouterRun = {
  id: string; session_key: string; model: string;
  kept: number; dropped: number; error: string | null; created_at: string;
};
export type ConsolidationRun = {
  id: string; document_id: string | null; trace_id: string | null; model: string;
  through: number | null;
  added: number; extended: number; replaced: number; retired: number; affirmed: number; dropped: number;
  input_tokens: number | null; output_tokens: number | null; duration_ms: number | null;
  error: string | null; created_at: string;
};
export type DocumentRow = {
  id: string; session_key: string; project_id: string | null; project_slug: string | null;
  turns: number; chars: number; started_at: string; last_turn_at: string;
  consolidated_at: string | null; consolidated_through: number | null;
  truncated_at: string | null; expires_at: string;
};
export type DocumentTurn = { id: number; role: string; content: string; created_at: string };
/** What a model was sent and what it sent back, read only when someone opens
 *  the row that summarises it. */
export type RunText = { prompt: string; response: string | null };

/** One page of the feed, and whether asking again would bring more.
 *
 *  `more` is generous on purpose: a source that returned a full page may have
 *  nothing behind it, and offering one empty "Show more" is a far smaller
 *  fault than hiding records because the arithmetic was clever. */
export type ActivityPage = { items: Activity[]; more: boolean };

/** What one consolidation pass did to one conversation. Counted by action
 *  rather than totalled, because "added three" and "retired three" are very
 *  different afternoons. */
export type ConsolidationOutcome = {
  document?: string; skipped?: string; failed?: string;
  added: number; extended: number; replaced: number; retired: number;
  affirmed: number; dropped: number;
};
/** One change the pass made, or tried to, with the model's reason. */
export type JobAction = { did: string; on: string | null; statement?: string | null; why?: string | null };
/** What one session came to inside a job. */
export type JobRun = ConsolidationOutcome & { session_key?: string; scope?: string; actions?: JobAction[]; spent?: boolean };

/** A consolidation you start and come back to. The row is the progress while
 *  it runs and the report once it stops. */
export type ConsolidationJob = {
  id: string; status: 'running' | 'finished' | 'stopped'; stop_reason: string | null;
  idle_minutes: number; started_at: string; deadline_at: string; heartbeat_at: string;
  finished_at: string | null; step: number; waiting: number; read: number;
  added: number; extended: number; replaced: number; retired: number; affirmed: number;
  dropped: number; failed: number; runs: JobRun[];
};

/** A running job whose row has not moved for this long has lost its chain.
 *  The same six minutes the server uses before it lets anyone take over. */
export const STALLED_MS = 6 * 60 * 1000;
export type JobState = 'running' | 'stalled' | 'finished' | 'stopped';
export function jobState(job: ConsolidationJob, now = Date.now()): JobState {
  if (job.status !== 'running') return job.status;
  return now - Date.parse(job.heartbeat_at) > STALLED_MS ? 'stalled' : 'running';
}

const minutes = (from: string, to: number) => Math.max(0, Math.round((to - Date.parse(from)) / 60000));

/** The one line under the title. Counts by action, like a single run, and
 *  "changed nothing" said as the ordinary answer it is. */
export function summarizeJob(job: ConsolidationJob, now = Date.now()): string {
  const changes = (['added', 'extended', 'replaced', 'retired', 'affirmed'] as const)
    .filter(action => job[action] > 0).map(action => `${job[action]} ${action}`);
  const read = `${job.read} of ${count(job.waiting, 'session')}`;
  const state = jobState(job, now);
  if (state === 'running' || state === 'stalled') {
    const took = minutes(job.started_at, now);
    return `Read ${read} so far · ${took} ${took === 1 ? 'minute' : 'minutes'} in${changes.length ? ` · ${changes.join(', ')}` : ''}`;
  }
  const took = minutes(job.started_at, Date.parse(job.finished_at ?? job.heartbeat_at));
  const failed = job.failed ? ` · ${job.failed} failed` : '';
  const done = changes.length ? changes.join(', ') : 'changed nothing, which is the usual answer';
  return `Read ${read} in ${took < 1 ? 'under a minute' : `${took} ${took === 1 ? 'minute' : 'minutes'}`} · ${done}${failed}`;
}

/** One session's line in the report. */
export function summarizeJobRun(run: JobRun): string {
  if (run.failed) return run.failed;
  if (run.skipped) return 'nothing new since the last read';
  const said = ([['added', run.added], ['extended', run.extended], ['replaced', run.replaced],
    ['retired', run.retired], ['affirmed', run.affirmed], ['rejected', run.dropped]] as const)
    .filter(([, n]) => n > 0).map(([word, n]) => `${n} ${word}`);
  return said.length ? said.join(', ') : 'nothing to change';
}

export type MemoryEvent = {
  id: string; memory_id: string; action: string; before: string | null; after: string | null;
  reason: string | null; actor: string; trace_id: string | null; document_id: string | null; created_at: string;
};

export type Activity =
  | { kind: 'session'; id: string; at: string; detail: Injection }
  | { kind: 'prompt'; id: string; at: string; detail: Injection }
  | { kind: 'capture'; id: string; at: string; detail: RouterRun }
  | { kind: 'consolidation'; id: string; at: string; detail: ConsolidationRun }
  | { kind: 'document'; id: string; at: string; detail: DocumentRow }
  | { kind: 'memory'; id: string; at: string; detail: MemoryEvent };

export const KIND_LABEL: Record<ActivityKind, string> = {
  session: 'Session start', prompt: 'Prompt', capture: 'Capture',
  consolidation: 'Consolidation', document: 'Document', memory: 'Memory',
};

/** Which filter a row belongs under. Requests are the three things a hook or a
 *  schedule asked the server to do; the other two are what came out of them. */
export const GROUP: Record<ActivityKind, 'requests' | 'documents' | 'memory'> = {
  session: 'requests', prompt: 'requests', capture: 'requests',
  consolidation: 'requests', document: 'documents', memory: 'memory',
};

export function summarize(item: Activity): string {
  if (item.kind === 'session')
    return `${count(item.detail.memory_ids.length, 'memory', 'memories')} loaded · ${item.detail.tokens} tokens`;
  if (item.kind === 'prompt')
    return item.detail.memory_ids.length
      ? `${item.detail.memory_ids.length} of ${item.detail.matched} shown · ${item.detail.in_scope} in scope`
      : 'nothing matched';
  if (item.kind === 'capture')
    return item.detail.error ? item.detail.error
      : `kept ${item.detail.kept}, dropped ${item.detail.dropped}`;
  if (item.kind === 'consolidation') {
    const run = item.detail;
    if (run.error) return run.error;
    const changes = [['added', run.added], ['extended', run.extended], ['replaced', run.replaced],
      ['retired', run.retired], ['affirmed', run.affirmed], ['rejected', run.dropped]] as const;
    const said = changes.filter(([, n]) => n > 0).map(([word, n]) => `${n} ${word}`);
    return said.length ? said.join(', ') : 'nothing to change';
  }
  if (item.kind === 'document')
    return `${count(item.detail.turns, 'turn')} · ${item.detail.chars.toLocaleString()} characters`;
  return item.detail.action;
}
