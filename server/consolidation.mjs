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
import {firstChunk} from './turn-chunks.mjs';

const untraced = (_name, _options, run) => run(() => {}, () => {}, null);

/** Applies one model decision. Returns the action it managed, or null.
 *
 *  Each change is caught on its own. One memory that moved under us, or one
 *  row that will not write, must not cost the rest of the run: the alternative
 *  is a document that half applied and is then marked as read. */
async function apply(service, change, {topics, trace, document, consolidator = null, deadline = null, now}) {
  const slug = change.topic ?? null;
  if (change.action === 'add') {
    // Said before, in other words? The model's own check is an exact match,
    // so a paraphrase of a live memory reached the database as a second row
    // and both then loaded. When a live memory in the same scope, or a
    // personal one that already loads everywhere, sits close to this claim,
    // the model is asked what the pair means and the answer is applied: an
    // affirm, an extend, a replace, or the add after all. Never decided on the
    // similarity score, which rates a contradiction higher than a paraphrase.
    // A twin in another topic is left alone and the add goes through,
    // because the same rule can hold in two topics without being one memory.
    const twin = await sameClaim(service, change, topics);
    if (twin && consolidator?.reconsider) {
      let verdict = null;
      try { verdict = await consolidator.reconsider({proposed: change, existing: twin, now}, {deadline}); }
      catch { verdict = null; }
      const why = `${verdict?.why ?? 'the model could not be asked'} · proposed: "${String(change.statement).slice(0, 120)}"`;
      // R11: the verdict and the raw answer travel with the action, so the run
      // row says what decided the write and not only that it happened.
      const asked = verdict ? {action: verdict.action, twin: twin.id, raw: verdict.raw ?? null} : null;
      if (verdict?.action === 'affirm') {
        await service.affirmMemory(twin.id, {trace, document});
        return {did: 'affirmed', on: twin.id, why, asked};
      }
      if (verdict?.action === 'extend') {
        await service.extendMemory({id: twin.id, revision: twin.revision, statement: verdict.statement, trace, document});
        return {did: 'extended', on: twin.id, why, asked};
      }
      if (verdict?.action === 'replace') {
        // The successor lives where the claim it replaces lived. A personal
        // twin loads in every session, and a replace proposed from inside one
        // topic must not narrow it to that topic: nobody said it should.
        const where = twin.topic_id ? topics.find(p => p.id === twin.topic_id)?.slug ?? slug : null;
        const written = await service.captureMemory({id: crypto.randomUUID(), statement: verdict.statement,
          source: change.source, topic: where, kind: change.kind, expires: change.expires ?? null, trace, document});
        await service.endMemory({id: twin.id, revision: twin.revision, reason: 'replaced', ended_by: written.id,
          note: verdict.why, trace, document});
        return {did: 'replaced', on: twin.id, why, asked};
      }
    }
    await service.captureMemory({id: crypto.randomUUID(), statement: change.statement,
      source: change.source, topic: slug, kind: change.kind,
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
      source: change.source, topic: slug, kind: change.kind,
      expires: change.expires ?? null, trace, document});
    await service.endMemory({id: change.target, revision: change.revision,
      reason: 'replaced', ended_by: written.id, note: change.why, trace, document});
    return 'replaced';
  }
  return null;
}

/** A live memory that already says what this add says, when the service can
 *  look. Optional, so a replay or a test without an embedder adds as before. */
async function sameClaim(service, change, topics) {
  if (!service.nearest) return null;
  let near;
  try { near = await service.nearest(change.statement); } catch { return null; }
  if (!near) return null;
  const target = change.topic ? topics.find(p => p.slug === change.topic)?.id ?? null : null;
  return near.topic_id == null || near.topic_id === target ? near : null;
}

/** Whether this pass may make a topic of its own. Only on a connection that
 *  sees every topic and may write: a topic made under a narrower grant is
 *  one the pass cannot see afterwards, so the next session would make it
 *  again. SATCHEL_NEW_TOPICS=off turns it off without a deploy of code. */
async function mayMakeTopics(service) {
  if (process.env.SATCHEL_NEW_TOPICS === 'off' || !service.status || !service.upsertTopic) return false;
  try {
    const status = await service.status();
    return status?.all_topics === true && status?.can_write === true;
  } catch { return false; }
}

/** Makes each new topic the model named, as a topic, and adds it to the
 *  list the rest of the batch sees so the next session reuses it. */
async function makeTopics(service, named, topics) {
  const made = [];
  const failed = new Set();
  for (const topic of named) {
    if (topics.some(p => p.slug === topic.slug)) continue;
    try {
      const id = crypto.randomUUID();
      const name = topic.slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      const out = service.createSatchelTopic
        ? await service.createSatchelTopic({request_id: crypto.randomUUID(), topic_id: id, slug: topic.slug,
          name, brief: topic.brief})
        : await service.upsertTopic({request_id: crypto.randomUUID(), topic_id: id, slug: topic.slug,
          name, brief: topic.brief, repository_change: {kind: 'unchanged'}});
      if (out?.grant_required) { failed.add(topic.slug); continue; }
      const row = {id: out?.topic?.id ?? out?.id ?? id, slug: topic.slug, brief: topic.brief, topic_repositories: []};
      topics.push(row);
      made.push(row);
    } catch { failed.add(topic.slug); }
  }
  return {made, failed};
}

/** Once a job: file what sits in personal under the topics it belongs to,
 *  and fold together topics that are one subject. Returns a run for the job
 *  row, or null when there was nothing to ask about.
 *
 *  Never stops the pass. A tidy that fails is a night where personal stayed
 *  as it was, which is how every night went before topics existed. */
export async function tidyTopics(service, tidier, {traced = untraced, ownerId, deadline = null} = {}) {
  if (!tidier || !service.moveMemory || !await mayMakeTopics(service)) return null;
  return traced('satchel.tidy', {userId: ownerId, metadata: {event: 'tidy'}, tags: ['satchel', 'tidy'], input: null},
    async setOutput => {
      const counts = {moved: 0, merged: 0, topics: 0, dropped: 0};
      const run = {document: 'tidy', session_key: 'personal', scope: 'tidy', ...counts, actions: []};
      try {
        const listed = await service.topics();
        const memories = (await service.memoriesInScope(null, 200)).filter(m => !m.topic_id);
        const made = listed.filter(p => p.made_by === 'satchel');
        if (!memories.length && made.length < 2) return null;
        const topics = listed.map(p => ({id: p.id, slug: p.slug, brief: p.brief, made_by: p.made_by ?? 'person'}));
        const outcome = await tidier.tidy({topics, memories}, {deadline});
        run.dropped = outcome.dropped.length;
        const fresh = await makeTopics(service, outcome.named, listed);
        for (const topic of fresh.made) {
          run.topics += 1;
          run.actions.push({did: 'made topic', on: topic.id, statement: topic.slug, why: topic.brief});
        }
        for (const merge of outcome.merges) {
          try {
            await service.mergeTopic({from: merge.from.id, into: merge.into.id, note: merge.why});
            run.merged += 1;
            run.actions.push({did: 'merged topic', on: merge.from.id,
              statement: `${merge.from.slug} into ${merge.into.slug}`, why: merge.why});
          } catch (error) {
            run.actions.push({did: 'failed', on: merge.from.id, statement: `merge ${merge.from.slug}`, why: errorText(error)});
          }
        }
        for (const move of outcome.moves) {
          const target = listed.find(p => p.slug === move.slug);
          if (!target || fresh.failed.has(move.slug)) continue;
          try {
            await service.moveMemory({id: move.memory.id, revision: move.memory.revision, topic_id: target.id,
              note: move.why});
            run.moved += 1;
            run.actions.push({did: 'moved', on: move.memory.id, statement: `${move.memory.statement} → ${move.slug}`,
              why: move.why});
          } catch (error) {
            run.actions.push({did: 'failed', on: move.memory.id, statement: move.memory.statement, why: errorText(error)});
          }
        }
      } catch (error) {
        run.failed = errorText(error);
      }
      setOutput(run.actions);
      return run;
    });
}

/** Personal memories and every topic's own, once each. A session with no
 *  topic can still be about one, and the pass cannot extend or affirm a
 *  topic memory it was never shown, or tell that an add repeats one. */
async function memoriesAcross(service, topics, limit = 60) {
  // Each topic call returns the personal rows first, so its limit is raised
  // by that many or the personal ones would crowd the topic's own out.
  const personal = await service.memoriesInScope(null, limit);
  const own = await Promise.all(topics.map(topic =>
    service.memoriesInScope(topic.id, limit + personal.length)));
  return [...personal, ...own.flat().filter(memory => memory.topic_id)];
}

/** One document. Read, decide, apply, and say so.
 *
 *  Returns what it did rather than throwing, because the caller is a loop over
 *  documents and one failure must not end the others. */
export async function consolidateDocument(service, consolidator, document,
  {topics = [], cap = 30, churn = 25, deadline = null, traced = untraced, ownerId, topicsAllowed = false} = {}) {
  return traced('satchel.consolidate',
    {sessionId: document.session_key, userId: ownerId,
     metadata: {event: 'consolidate', document: document.id,
       scope: document.topic_id ?? 'personal', turns: document.turns},
     tags: ['satchel', 'consolidate'], input: null},
    async (setOutput, setInput, traceId) => {
      const runId = crypto.randomUUID();
      const started = Date.now();
      const counts = {added: 0, extended: 0, replaced: 0, retired: 0, affirmed: 0, dropped: 0, topics: 0};
      // Only what has not been read. A session that carried on after a pass is
      // pending again, and re-reading what the last run already decided about
      // is a model call spent on nothing and a second chance to save the same
      // claim twice.
      // Scrubbed again on the way out. The hooks scrub what comes in now, and
      // this is for what was kept before they did: a model that has not seen
      // a password cannot write one into a memory.
      const unread = (await service.documentTurns(document.id, document.consolidated_through ?? null))
        .map(turn => ({...turn, content: scrub(turn.content)}));
      // Never a shorter view of a turn. A session too long for one call is
      // read in pieces, each one after the last piece's changes are written.
      const turns = firstChunk(unread);
      const rest = unread.length - turns.length;
      const through = turns.at(-1)?.id ?? document.consolidated_through ?? null;
      if (!turns.length) return {...counts, document: document.id, session_key: document.session_key,
        skipped: 'nothing new'};
      const memories = document.topic_id || !topics.length
        ? await service.memoriesInScope(document.topic_id ?? null)
        : await memoriesAcross(service, topics);
      const topic = topics.find(p => p.id === document.topic_id) ?? null;
      setInput({turns: turns.length, memories: memories.length,
        scope: topic?.slug ?? 'personal'});
      let outcome;
      try {
        outcome = await consolidator.consolidate({
          topic: topic ? {slug: topic.slug, brief: topic.brief} : null,
          topics: topics.filter(p => p.id !== document.topic_id).map(p => ({slug: p.slug, brief: p.brief,
            repositories: (p.topic_repositories ?? []).map(r => r.repository)})),
          codebase: topic ? null : document.repository ?? null,
          memories, turns, cap, churn, topicsAllowed,
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
      const made = await makeTopics(service, outcome.named ?? [], topics);
      for (const topic of made.made) {
        counts.topics += 1;
        actions.push({did: 'made topic', on: topic.id, statement: topic.slug, why: topic.brief});
      }
      for (const change of outcome.changes) {
        // A topic that could not be made leaves its memory where it would
        // have gone before topics existed, which is personal.
        if (made.failed.has(change.topic)) change.topic = null;
        try {
          const out = await apply(service, change, {topics, trace: traceId, document: document.id,
            consolidator, deadline, now: turns.at(-1)?.created_at});
          const did = typeof out === 'string' ? out : out?.did;
          if (did) {
            counts[did] += 1;
            actions.push({did, on: out?.on ?? change.target ?? null, statement: change.statement,
              why: out?.why ?? change.why, ...(out?.asked ? {asked: out.asked} : {})});
          }
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
      const result = {...counts, document: document.id, session_key: document.session_key,
        scope: topic?.slug ?? 'personal', actions};
      if (!rest) return result;
      const next = await consolidateDocument(service, consolidator,
        {...document, consolidated_through: through},
        {topics, cap, churn, deadline, traced, ownerId, topicsAllowed});
      for (const key of Object.keys(counts)) result[key] += next[key] ?? 0;
      result.actions = [...actions, ...(next.actions ?? [])];
      if (next.failed) Object.assign(result, {failed: next.failed, spent: next.spent, later: next.later});
      return result;
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
  const [topics, settings, topicsAllowed] = await Promise.all([service.topics(), service.settings(),
    mayMakeTopics(service)]);
  const runs = [];
  for (const document of documents) {
    // Not "is there time for this one", which needs a guess at how long it
    // takes. The call itself is bounded by whatever is left, so the worst
    // case is a document that gives up rather than one that is cut in half.
    if (Date.now() >= deadline) break;
    runs.push(await consolidateDocument(service, consolidator, document,
      {topics, cap: settings.block_size, churn: settings.staleness_commits,
       deadline, traced, ownerId, topicsAllowed}));
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
  {budgetMs = 240000, traced = untraced, ownerId, now = Date.now, tidier = null} = {}) {
  const wall = Date.parse(job.deadline_at);
  const deadline = Math.min(now() + budgetMs, wall);
  // A session already tried in this job is not tried again, even though a
  // failed one is still pending. Asking the same question of a model that
  // just refused it is how a chain spends its 30 minutes on one session.
  const tried = new Set((job.runs ?? []).map(run => run.document));
  // Rows the embedder missed are repaired first, under the same token the
  // pass reads with. Never allowed to stop the pass: a memory that cannot be
  // embedded is still a memory, it is only one retrieval cannot see.
  try { await service.reembedMissing?.(); } catch { /* retrieval only, the pass goes on */ }
  // The conversation text kept in the run logs expires on the documents' 30
  // day clock. Done here and not in record_turn, which runs on every prompt
  // inside the hook's budget: three log tables are nothing to scan once a job
  // and something to scan on every keystroke.
  try { await service.expireRunLogs?.(); } catch { /* retention, never the pass */ }
  let current = job;
  // First, and once a job: the tidy reads what is already stored, so it does
  // not wait on there being a new session to read.
  if (!tried.has('tidy')) {
    const run = await tidyTopics(service, tidier, {traced, ownerId, deadline});
    if (run) {
      tried.add('tidy');
      current = await service.moveConsolidationJob(current.id, current.step,
        {runs: [...(current.runs ?? []), run]}) ?? current;
    }
  }
  const waiting = (await service.pendingDocuments(job.idle_minutes)).filter(d => !tried.has(d.id));
  const stop = async (reason, patch = {}) => {
    current = await service.moveConsolidationJob(current.id, current.step, {
      status: 'finished', ...patch, stop_reason: reason, finished_at: new Date(now()).toISOString()}) ?? current;
    return {job: current, more: false};
  };
  if (!waiting.length) return stop(tried.size ? 'Every waiting session was read.' : 'Nothing was waiting.');
  const [topics, settings, topicsAllowed] = await Promise.all([service.topics(), service.settings(),
    mayMakeTopics(service)]);
  let failures = 0;
  let index = 0;
  for (; index < waiting.length && now() < deadline; index++) {
    const run = await consolidateDocument(service, consolidator, waiting[index],
      {topics, cap: settings.block_size, churn: settings.staleness_commits,
       deadline, traced, ownerId, topicsAllowed});
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
