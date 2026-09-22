import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import type { Activity, ConsolidationRun, DocumentRow, DocumentTurn, Injection, MemoryEvent, RouterRun } from './model';

/** One page of everything, newest first.
 *
 *  Six reads in parallel rather than one view, because five of these tables
 *  are read through their own row policies and the sixth is closed to agent
 *  connections entirely. A view over all six would have to pick one of those
 *  rules and would quietly be wrong for the others.
 *
 *  Each read is capped on its own. A day of prompts would otherwise crowd out
 *  the one consolidation run you came to look at, which is the failure this
 *  page exists to avoid. */
export function createActivityRepository(db: SupabaseClient) {
  const rows = async <T>(run: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    const { data, error } = await requestWithTimeout(run);
    if (error) throw error;
    return (data ?? []) as T[];
  };

  return {
    async recent(limit = 40): Promise<Activity[]> {
      const [injections, captures, consolidations, documents, events] = await Promise.all([
        rows<Injection>(signal => db.from('memory_injections')
          .select('id,session_key,event,query,memory_ids,matched,in_scope,tokens,created_at')
          .order('created_at', { ascending: false }).limit(limit).abortSignal(signal)),
        rows<RouterRun>(signal => db.from('router_runs')
          .select('id,session_key,model,prompt,response,kept,dropped,error,created_at')
          .order('created_at', { ascending: false }).limit(limit).abortSignal(signal)),
        rows<ConsolidationRun>(signal => db.from('consolidation_runs')
          .select('id,document_id,trace_id,model,prompt,response,through,added,extended,replaced,retired,affirmed,dropped,input_tokens,output_tokens,duration_ms,error,created_at')
          .order('created_at', { ascending: false }).limit(limit).abortSignal(signal)),
        rows<DocumentRow>(signal => db.rpc('recent_documents', { p_limit: limit }).abortSignal(signal)),
        rows<MemoryEvent>(signal => db.from('memory_events')
          .select('id,memory_id,action,before,after,reason,actor,trace_id,document_id,created_at')
          .order('created_at', { ascending: false }).limit(limit).abortSignal(signal)),
      ]);
      const stream: Activity[] = [
        // Session start and a prompt are the same row in the same table and
        // two completely different events. One loads everything personal once,
        // the other searches for one message, and reading them as one line
        // would hide which of the two put a memory in front of the model.
        ...injections.map(detail => ({
          kind: detail.event === 'UserPromptSubmit' ? 'prompt' as const : 'session' as const,
          id: detail.id, at: detail.created_at, detail,
        })),
        ...captures.map(detail => ({ kind: 'capture' as const, id: detail.id, at: detail.created_at, detail })),
        ...consolidations.map(detail => ({ kind: 'consolidation' as const, id: detail.id, at: detail.created_at, detail })),
        // A document is dated by its last turn, not by when it started. It is
        // a thing that keeps growing, and the question being asked here is
        // "what happened recently".
        ...documents.map(detail => ({ kind: 'document' as const, id: detail.id, at: detail.last_turn_at, detail })),
        ...events.map(detail => ({ kind: 'memory' as const, id: detail.id, at: detail.created_at, detail })),
      ];
      return stream.sort((a, b) => b.at.localeCompare(a.at));
    },

    /** The conversation itself, oldest first, which is the order it was said
     *  in. Loaded only when a document is opened: a page that pulled every
     *  turn of every session up front would be the transcript this design
     *  exists not to hold in one place. */
    async turns(documentId: string): Promise<DocumentTurn[]> {
      return rows<DocumentTurn>(signal =>
        db.rpc('document_content', { p_document_id: documentId }).abortSignal(signal));
    },
  };
}
export type ActivityRepository = ReturnType<typeof createActivityRepository>;
