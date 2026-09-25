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
import {scrub} from './secrets.mjs';

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
      source: change.source, project: slug, kind: change.kind,
      expires: change.expires ?? null, trace, document});
    return 'added';
  }
  if (change.action === 'extend') {
    await service.extendMemory({id: change.target, revision: change.revision,
      statement: change.statement, trace, document});
    return 'extended';
  }
  if (change.action === 'affirm') {
    // Not an edit: the wording did not change, the evidence for it did. A
    // claim restated is stronger than one said once, and on a heard memory it
    // is the confirmation, so it becomes `said` and the history says so.
    await service.affirmMemory(change.target, {trace, document});
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
      source: change.source, project: slug, kind: change.kind,
      expires: change.expires ?? null, trace, document});
    await service.endMemory({id: change.target, revision: change.revision,
      reason: 'replaced', ended_by: written.id, note: change.why, trace, document});
    return 'replaced';
  }
  return null;
  // `projects` is unused here and named so the caller can see the scope it
  // resolved; resolution happens in the database, from the slug.
}

/** Personal memories and every project's own, once each. A session with no
 *  project can still be about one, and the pass cannot extend or affirm a
 *  project memory it was never shown, or tell that an add repeats one. */
async function memoriesAcross(service, projects) {
  const byId = new Map();
  for (const project of projects)
    for (const memory of await service.memoriesInScope(project.id)) byId.set(memory.id, memory);
  return [...byId.values()].sort((a, b) => Number(Boolean(a.project_id)) - Number(Boolean(b.project_id)));
}

/** One document. Read, decide, apply, and say so.
 *
 *  Returns what it did rather than throwing, because the caller is a loop over
 *  documents and one failure must not end the others. */
export async function consolidateDocument(service, consolidator, document,
  {projects = [], cap = 30, churn = 25, deadline = null, traced = untraced, ownerId} = {}) {
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
      // Scrubbed again on the way out. The hooks scrub what comes in now, and
      // this is for what was kept before they did: a model that has not seen
      // a password cannot write one into a memory.
      const turns = (await service.documentTurns(document.id, document.consolidated_through ?? null))
        .map(turn => ({...turn, content: scrub(turn.content)}));
      const through = turns.at(-1)?.id ?? document.consolidated_through ?? null;
      if (!turns.length) return {...counts, document: document.id, session_key: document.session_key,
        skipped: 'nothing new'};
      const memories = document.project_id || !projects.length
        ? await service.memoriesInScope(document.project_id ?? null)
        : await memoriesAcross(service, projects);
      const project = projects.find(p => p.id === document.project_id) ?? null;
      setInput({turns: turns.length, memories: memories.length,
        scope: project?.slug ?? 'personal'});
      let outcome;
      try {
        outcome = await consolidator.consolidate({
          project: project ? {slug: project.slug, brief: project.brief} : null,
          projects: projects.filter(p => p.id !== document.project_id).map(p => ({slug: p.slug, brief: p.brief,
            repositories: (p.project_repositories ?? []).map(r => r.repository)})),
          memories, turns, cap, churn,
        }, {deadline});
      } catch (error) {
        // The document is left pending. A run that never reached the model has
        // decided nothing, and the next pass should ask again.
        await service.logConsolidationRun({id: runId, document_id: document.id, trace_id: traceId,
          model: consolidator.model, prompt: '(not sent)', response: null,
          duration_ms: Date.now() - started, error: errorText(error)});
        // `spent` is the one failure worth stopping a whole job for: a daily
        // quota that is gone is gone for every session after this one, and
        // there is no other model to ask. `later` is a model that could not
        // answer and a call with no room left to wait for it, which a job
        // hands to its next step instead of counting as a failure.
        return {...counts, document: document.id, session_key: document.session_key,
          failed: errorText(error), spent: error?.code === 'ROUTER_LIMIT' && error?.spent === true,
          later: error?.later === true};
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
        model: outcome.model ?? consolidator.model, prompt: outcome.prompt, response: outcome.raw, through,
        ...counts, input_tokens: outcome.usage?.inputTokens ?? null,
        output_tokens: outcome.usage?.outputTokens ?? null,
        duration_ms: Date.now() - started, error: null});
      return {...counts, document: document.id, session_key: document.session_key,
        scope: project?.slug ?? 'personal', actions};
    });
}

/** Every session that has gone quiet and has something nobody has read, for
 *  as long as the caller has.
 *
 *  `budgetMs` is the wall, and it is the serverless function's rather than the
 *  model's. One document is now a thinking model reading a whole session, so a
 *  backlog no longer reliably fits in one request. Running out of time is
 *  fine and expected: what is read is marked, what is not stays pending, and
 *  the answer says how much is left so the caller can say so out loud instead
 *  of looking finished. Being killed partway is the thing to avoid, because a
 *  document can then be half applied and unmarked.
 *
 *  There is no count. It took ten at a time, and on 22 September that left
 *  the three most recent sessions unread with 19 of its 45 seconds unused,
 *  one of them holding the clearest standing rule of the day. How many
 *  sessions are waiting is not a reason to stop reading them. */
export async function consolidatePending(service, consolidator,
  {idleMinutes = 30, budgetMs = 45000, traced = untraced, ownerId} = {}) {
  const deadline = Date.now() + budgetMs;
  const documents = await service.pendingDocuments(idleMinutes);
  if (!documents.length) return {documents: 0, remaining: 0, runs: []};
  // Read once for the whole batch rather than per document. Scope resolution
  // is by id here, not by repository: the workspace is long gone. The cap
  // comes from settings so the pass judges against the same number the
  // session start injects under.
  const [projects, settings] = await Promise.all([service.projects(), service.settings()]);
  const runs = [];
  for (const document of documents) {
    // Not "is there time for this one", which needs a guess at how long it
    // takes. The call itself is bounded by whatever is left, so the worst
    // case is a document that gives up rather than one that is cut in half.
    if (Date.now() >= deadline) break;
    runs.push(await consolidateDocument(service, consolidator, document,
      {projects, cap: settings.block_size, churn: settings.staleness_commits,
       deadline, traced, ownerId}));
  }
  return {documents: runs.length, remaining: documents.length - runs.length, runs};
}

const TOTALS = ['added', 'extended', 'replaced', 'retired', 'affirmed', 'dropped'];

/** One call's share of a job: read sessions until this call's time is up, then
 *  say whether the chain should carry on.
 *
 *  A job is a chain because one call cannot run for 30 minutes. Vercel stops a
 *  function at 300 seconds on Hobby and 800 on Pro, whatever framework it is
 *  written in, so a long pass has to be cut into pieces somewhere. Here each
 *  piece is a few minutes, and the job row carries everything between them.
 *
 *  The row is moved after every session rather than at the end, for two
 *  reasons. The page shows progress while it runs. And a call that dies
 *  partway loses one session's worth at most: everything before it is already
 *  on the row, and the session itself was either marked or it was not.
 *
 *  Three ways to stop, and each one says why on the row, because a job that
 *  ended without saying so looks exactly like one that is still going:
 *  nothing left, the 30 minutes are up, or the model cannot answer. */
export async function consolidateStep(service, consolidator, job,
  {budgetMs = 240000, traced = untraced, ownerId, now = Date.now} = {}) {
  const wall = Date.parse(job.deadline_at);
  const deadline = Math.min(now() + budgetMs, wall);
  // A session already tried in this job is not tried again, even though a
  // failed one is still pending. Asking the same question of a model that
  // just refused it is how a chain spends its 30 minutes on one session.
  const tried = new Set((job.runs ?? []).map(run => run.document));
  const waiting = (await service.pendingDocuments(job.idle_minutes)).filter(d => !tried.has(d.id));
  let current = job;
  const stop = async (reason, patch = {}) => {
    current = await service.moveConsolidationJob(current.id, current.step, {
      status: 'finished', ...patch, stop_reason: reason, finished_at: new Date(now()).toISOString()}) ?? current;
    return {job: current, more: false};
  };
  if (!waiting.length) return stop(tried.size ? 'Every waiting session was read.' : 'Nothing was waiting.');
  const [projects, settings] = await Promise.all([service.projects(), service.settings()]);
  let failures = 0;
  let index = 0;
  for (; index < waiting.length && now() < deadline; index++) {
    const run = await consolidateDocument(service, consolidator, waiting[index],
      {projects, cap: settings.block_size, churn: settings.staleness_commits,
       deadline, traced, ownerId});
    // The model could not answer and this call had no room to wait for it.
    // The next step starts with a full clock, and this session is the first
    // one it will reach, because nothing about it was written to the row.
    // Only while the job itself has room for the wait; after that it is an
    // ordinary failure, and the session stays pending for the next pass.
    if (run.later && wall - now() >= (consolidator.retryAfterMs ?? 0) + (consolidator.timeoutMs ?? 0))
      return {job: current, more: true};
    const patch = {read: current.read + 1, runs: [...(current.runs ?? []), run],
      failed: current.failed + (run.failed ? 1 : 0)};
    for (const key of TOTALS) patch[key] = (current[key] ?? 0) + (run[key] ?? 0);
    const moved = await service.moveConsolidationJob(current.id, current.step, patch);
    // Another call holds the job now. Whatever it is doing, it is not this
    // call's to finish, and writing over it would lose its sessions.
    if (!moved) return {job: current, more: false, lost: true};
    current = moved;
    if (run.spent)
      return stop(`The model's quota is used up for today. ${waiting.length - index - 1} sessions were left waiting.`,
        {status: 'stopped'});
    failures = run.failed ? failures + 1 : 0;
    if (failures >= 3)
      return stop(`Three sessions in a row failed, the last with: ${run.failed}`, {status: 'stopped'});
  }
  const left = waiting.length - index;
  if (!left) return stop('Every waiting session was read.');
  if (now() >= wall)
    return stop(`The 30 minutes ran out with ${left} ${left === 1 ? 'session' : 'sessions'} still waiting.`,
      {status: 'stopped'});
  return {job: current, more: true};
}
