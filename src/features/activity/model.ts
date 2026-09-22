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
export type RouterRun = {
  id: string; session_key: string; model: string; prompt: string; response: string | null;
  kept: number; dropped: number; error: string | null; created_at: string;
};
export type ConsolidationRun = {
  id: string; document_id: string | null; trace_id: string | null; model: string;
  prompt: string; response: string | null; through: number | null;
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
