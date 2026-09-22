// The background pass, one document at a time.
//
// Nobody is waiting for this. It runs after a conversation has gone quiet,
// reads the whole thing against the memories that already exist, and applies
// what the model decided. That is the part that makes it dangerous: a person
// watching a capture happen can delete a bad one, and nobody is watching this.
//
// So two things are load bearing rather than nice to have. Everything it does
// is reversible, because R4 ends memories instead of deleting them. And every
// run is on a trace and in consolidation_runs, including the runs that changed
// nothing, because a pass whose quiet answers are invisible cannot be argued
// with after the fact.
//
// What schedules it is not decided yet. This takes a service and runs; the
// endpoint and whatever calls it are somebody else's problem on purpose.
import {errorText} from './error-text.mjs';

const untraced = (_name, _options, run) => run(() => {}, () => {}, null);

/** Applies one model decision. Returns the action it managed, or null.
 *
 *  Each change is caught on its own. One memory that moved under us, or one
 *  row that will not write, must not cost the rest of the run: the alternative
 *  is a document that half applied and is then marked as read. */
async function apply(service, change, {projects, trace, document}) {
  const slug = change.project ?? null;
  if (change.action === 'add') {
    await service.captureMemory({id: crypto.randomUUID(), statement: change.statement,
      source: change.source, project: slug, kind: change.kind, trace, document});
    return 'added';
  }
  if (change.action === 'extend') {
    await service.extendMemory({id: change.target, revision: change.revision,
      statement: change.statement, trace, document});
    return 'extended';
  }
  if (change.action === 'affirm') {
    // Not an edit and not an event: the wording did not change, the evidence
    // for it did. A claim restated across sessions is stronger than one said
    // once, and that signal was free and being thrown away.
    await service.affirmMemory(change.target);
    return 'affirmed';
  }
  if (change.action === 'retire') {
    await service.endMemory({id: change.target, revision: change.revision,
      reason: 'retired', note: change.why, trace, document});
    return 'retired';
  }
  if (change.action === 'replace') {
    // The new claim first. If ending the old one then fails, the set holds
    // both, which is untidy and true. The other order loses the claim
    // entirely and leaves nothing saying it was ever made.
    const written = await service.captureMemory({id: crypto.randomUUID(), statement: change.statement,
      source: change.source, project: slug, kind: change.kind, trace, document});
    await service.endMemory({id: change.target, revision: change.revision,
      reason: 'replaced', ended_by: written.id, note: change.why, trace, document});
    return 'replaced';
  }
  return null;
  // `projects` is unused here and named so the caller can see the scope it
  // resolved; resolution happens in the database, from the slug.
}

/** One document. Read, decide, apply, and say so.
 *
 *  Returns what it did rather than throwing, because the caller is a loop over
 *  documents and one failure must not end the others. */
export async function consolidateDocument(service, consolidator, document,
  {projects = [], traced = untraced, ownerId} = {}) {
  return traced('satchel.consolidate',
    {sessionId: document.session_key, userId: ownerId,
     metadata: {event: 'consolidate', document: document.id,
       scope: document.project_id ?? 'personal', turns: document.turns},
     tags: ['satchel', 'consolidate'], input: null},
    async (setOutput, setInput, traceId) => {
      const runId = crypto.randomUUID();
      const started = Date.now();
      const counts = {added: 0, extended: 0, replaced: 0, retired: 0, affirmed: 0, dropped: 0};
      // Only what has not been read. A session that carried on after a pass is
      // pending again, and re-reading what the last run already decided about
      // is a model call spent on nothing and a second chance to save the same
      // claim twice.
      const turns = await service.documentTurns(document.id, document.consolidated_through ?? null);
      const through = turns.at(-1)?.id ?? document.consolidated_through ?? null;
      if (!turns.length) return {...counts, skipped: 'nothing new'};
      const memories = await service.memoriesInScope(document.project_id ?? null);
      const project = projects.find(p => p.id === document.project_id) ?? null;
      setInput({turns: turns.length, memories: memories.length,
        scope: project?.slug ?? 'personal'});
      let outcome;
      try {
        outcome = await consolidator.consolidate({
          project: project ? {slug: project.slug, brief: project.brief} : null,
          projects: projects.filter(p => p.id !== document.project_id).map(p => ({slug: p.slug, brief: p.brief})),
          memories, turns,
        });
      } catch (error) {
        // The document is left pending. A run that never reached the model has
        // decided nothing, and the next pass should ask again.
        await service.logConsolidationRun({id: runId, document_id: document.id, trace_id: traceId,
          model: consolidator.model, prompt: '(not sent)', response: null,
          duration_ms: Date.now() - started, error: errorText(error)});
        return {...counts, failed: errorText(error)};
      }
      counts.dropped = outcome.dropped.length;
      // R11. Every action taken and why, each naming the memory it touched,
      // and the ones validation refused with the reason it refused them.
      const actions = [];
      for (const change of outcome.changes) {
        try {
          const did = await apply(service, change, {projects, trace: traceId, document: document.id});
          if (did) { counts[did] += 1; actions.push({did, on: change.target ?? null, statement: change.statement, why: change.why}); }
        } catch (error) {
          counts.dropped += 1;
          actions.push({did: 'failed', on: change.target ?? null, statement: change.statement, why: errorText(error)});
        }
      }
      for (const {change, why} of outcome.dropped)
        actions.push({did: 'rejected', on: change?.target ?? null, statement: change?.statement, why});
      setOutput(actions);
      // Marked only after the writes. A run that died halfway leaves the
      // document pending and the next pass sees the turns again, which can
      // duplicate a memory. That is the recoverable direction: the other one
      // loses the conversation's only chance to be read.
      if (through != null) await service.markDocumentConsolidated(document.id, through);
      await service.logConsolidationRun({id: runId, document_id: document.id, trace_id: traceId,
        model: consolidator.model, prompt: outcome.prompt, response: outcome.raw, through,
        ...counts, input_tokens: outcome.usage?.inputTokens ?? null,
        output_tokens: outcome.usage?.outputTokens ?? null,
        duration_ms: Date.now() - started, error: null});
      return {...counts, document: document.id};
    });
}

/** Every session that has gone quiet and has something nobody has read. */
export async function consolidatePending(service, consolidator,
  {idleMinutes = 30, limit = 10, traced = untraced, ownerId} = {}) {
  const documents = await service.pendingDocuments(idleMinutes, limit);
  if (!documents.length) return {documents: 0, runs: []};
  // Read once for the whole batch rather than per document. Scope resolution
  // is by id here, not by repository: the workspace is long gone.
  const projects = await service.projects();
  const runs = [];
  for (const document of documents)
    runs.push(await consolidateDocument(service, consolidator, document, {projects, traced, ownerId}));
  return {documents: documents.length, runs};
}
