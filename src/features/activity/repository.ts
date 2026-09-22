import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import type { Activity, ActivityPage, ConsolidationResult, ConsolidationRun, DocumentRow, DocumentTurn, Injection, MemoryEvent, RouterRun, RunText } from './model';

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
    /** One page, newest first, merged across the six sources.
     *
     *  Paged by time rather than by offset. An offset into a merged list means
     *  nothing when each source is fetched on its own, and rows arrive while
     *  someone is reading.
     *
     *  Each source is asked for `limit`, which is enough. The page shows the
     *  newest `limit` of the merge, so anything dropped is older than the last
     *  row shown: a source cannot be hiding a newer row, because it returned
     *  its own newest `limit` and at most `limit` rows in the world are newer
     *  than the cutoff.
     *
     *  Neither `prompt` nor `response` is selected here. They are whole model
     *  prompts, capped at 40,000 and 200,000 characters, and this list renders
     *  one line per row. Reading them to draw that line is the mistake
     *  list_memories was written to prevent, and on this database it was
     *  already 939 KB across 123 router runs with another written every turn.
     */
    async recent({ limit = 25, before = null }: { limit?: number; before?: string | null } = {}): Promise<ActivityPage> {
      // Inclusive, and the caller drops what it has already seen. The cursor
      // is a moment rather than a row, and two sources can share a
      // microsecond; excluding the boundary would skip whichever one missed
      // the previous page.
      const olderThan = <T extends { lte(column: string, value: string): T }>(query: T) =>
        before ? query.lte('created_at', before) : query;
      const [injections, captures, consolidations, documents, events] = await Promise.all([
        rows<Injection>(signal => olderThan(db.from('memory_injections')
          .select('id,session_key,event,query,memory_ids,matched,in_scope,tokens,created_at')
          .order('created_at', { ascending: false }).limit(limit)).abortSignal(signal)),
        rows<RouterRun>(signal => olderThan(db.from('router_runs')
          .select('id,session_key,model,kept,dropped,error,created_at')
          .order('created_at', { ascending: false }).limit(limit)).abortSignal(signal)),
        rows<ConsolidationRun>(signal => olderThan(db.from('consolidation_runs')
          .select('id,document_id,trace_id,model,through,added,extended,replaced,retired,affirmed,dropped,input_tokens,output_tokens,duration_ms,error,created_at')
          .order('created_at', { ascending: false }).limit(limit)).abortSignal(signal)),
        rows<DocumentRow>(signal => db.rpc('recent_documents',
          { p_limit: limit, p_before: before }).abortSignal(signal)),
        rows<MemoryEvent>(signal => olderThan(db.from('memory_events')
          .select('id,memory_id,action,before,after,reason,actor,trace_id,document_id,created_at')
          .order('created_at', { ascending: false }).limit(limit)).abortSignal(signal)),
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
      stream.sort((a, b) => b.at.localeCompare(a.at));
      const full = [injections, captures, consolidations, documents, events].some(source => source.length >= limit);
      return { items: stream.slice(0, limit), more: stream.length > limit || full };
    },

    /** What a model was sent and what it said, for one row someone opened.
     *  This is where the long text lives now. */
    async runText(kind: 'capture' | 'consolidation', id: string): Promise<RunText> {
      const table = kind === 'capture' ? 'router_runs' : 'consolidation_runs';
      const found = await rows<RunText>(signal =>
        db.from(table).select('prompt,response').eq('id', id).limit(1).abortSignal(signal));
      return found[0] ?? { prompt: '', response: null };
    },

    /** The conversation itself, oldest first, which is the order it was said
     *  in. Loaded only when a document is opened: a page that pulled every
     *  turn of every session up front would be the transcript this design
     *  exists not to hold in one place. */
    async turns(documentId: string): Promise<DocumentTurn[]> {
      return rows<DocumentTurn>(signal =>
        db.rpc('document_content', { p_document_id: documentId }).abortSignal(signal));
    },

    /** Run the background pass now, over whatever has gone quiet.
     *
     *  The only call in the app that does not go through PostgREST, because
     *  the work is a model call and Postgres cannot make one. It sends this
     *  browser session's own token, which `/api/consolidate` accepts
     *  alongside the scheduler's; everything it then does runs under the same
     *  row policies as the rest of this page.
     *
     *  Two minutes, not fifteen. A pass is a model call per conversation and
     *  the default timeout would give up partway through a backlog, leaving
     *  the person looking at an error for work that actually happened. */
    async consolidate(idleMinutes = 30, limit = 10): Promise<ConsolidationResult> {
      const { data, error: authError } = await db.auth.getSession();
      if (authError || !data.session) throw new Error('Sign in again to run this.');
      const response = await requestWithTimeout(signal => fetch('/api/consolidate', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json',
          authorization: `Bearer ${data.session!.access_token}` },
        body: JSON.stringify({ idle_minutes: idleMinutes, limit }),
      }), 120000);
      if (!response.ok) {
        // 503 is the honest one to name: it means no model key is configured,
        // which is a deployment fact rather than anything the person did.
        throw new Error(response.status === 503
          ? 'No consolidation model is configured for this deployment.'
          : `Satchel answered ${response.status}.`);
      }
      // `npm run dev` serves the app and not the endpoints, so this path
      // answers with index.html and a 200. Parsing that produces "Unexpected
      // token <", which is a confusing way to learn you are on the wrong
      // server.
      if (!response.headers.get('content-type')?.includes('json')) {
        throw new Error('This server does not run the endpoints. Use npm run serve, or the deployed app.');
      }
      return await response.json() as ConsolidationResult;
    },
  };
}
export type ActivityRepository = ReturnType<typeof createActivityRepository>;
