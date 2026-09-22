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
export type ConsolidationResult = { documents: number; remaining?: number; runs: ConsolidationOutcome[] };

/** One line for what a run came to. Nothing is the usual answer and it must
 *  not read like a failure: most conversations change nothing, and a pass that
 *  says so is working. */
export function summarizeRun(result: ConsolidationResult): string {
  if (!result.documents) return 'Nothing was ready. A session counts as finished after 30 quiet minutes.';
  const totals = result.runs.reduce((sum, run) => ({
    added: sum.added + (run.added ?? 0), extended: sum.extended + (run.extended ?? 0),
    replaced: sum.replaced + (run.replaced ?? 0), retired: sum.retired + (run.retired ?? 0),
    affirmed: sum.affirmed + (run.affirmed ?? 0), dropped: sum.dropped + (run.dropped ?? 0),
  }), { added: 0, extended: 0, replaced: 0, retired: 0, affirmed: 0, dropped: 0 });
  const changes = (['added', 'extended', 'replaced', 'retired', 'affirmed'] as const)
    .filter(action => totals[action] > 0)
    .map(action => `${totals[action]} ${action}`);
  const read = count(result.documents, 'conversation');
  // A batch stops on the clock rather than running past what the request has,
  // so "there is more" is an ordinary answer and the person needs to be told
  // rather than left thinking it finished.
  const left = result.remaining ? ` · ${result.remaining} still waiting, press again` : '';
  if (!changes.length) return `Read ${read} and changed nothing, which is the usual answer.${left}`;
  return `Read ${read} · ${changes.join(', ')}${left}`;
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
