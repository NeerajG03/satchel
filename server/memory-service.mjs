// From vector.mjs and not embedding.mjs: these two are pure, and reaching them
// through the embedder would load the Vercel AI SDK into every endpoint that
// touches the service, including the one a session start waits on.
import {indexedText, toVectorLiteral} from './vector.mjs';

// Request-scoped adapter. RLS remains authoritative even for direct RPC calls.
export function memoryService(db, embedder = null, router = null) {
  async function result(query) {
    const {data,error} = await query.abortSignal(AbortSignal.timeout(8000));
    if (error) throw error;
    return data;
  }
  // A row is only searchable once embedded. Embedding failure leaves the row
  // saved and unsearchable rather than losing the write, because the user asked
  // for the memory, not for the index entry.
  async function embedRow(row) {
    if (!embedder || !row?.id) return;
    try {
      // 'document' is the stored side of an asymmetric model. It is inert
      // unless a taskType is configured, and turning that on changes
      // embedder.model too, so the two spaces stay distinguishable in the row.
      const vector=await embedder.embedOne(indexedText(row),'document');
      await result(db.from('memories').update({
        embedding:toVectorLiteral(vector),embedding_model:embedder.model,embedded_at:new Date().toISOString(),
      }).eq('id',row.id));
    } catch { /* Retrievable later by the backfill; the memory itself is saved. */ }
  }
  // One turn's worth of capture. Everything the router returns has already
  // been checked against what the user actually typed; this only resolves
  // scope and writes.
  async function captureTurn(sessionKey, {codebase, project, projects, context, turn, saved, trace}) {
    const runId = crypto.randomUUID();
    let outcome;
    try {
      outcome = await router.route({codebase, project, projects, context, turn, saved});
    } catch (error) {
      await api.logRouterRun({id:runId, session_key:sessionKey, model:router.model,
        prompt:'(not sent)', response:null, kept:0, dropped:0, error:String(error.message ?? error)});
      // `failed` is what decides whether the turn boundary moves. A run that
      // never reached the model must leave its messages unclassified so the
      // next turn picks them up, while a run that answered with an empty list
      // must move the boundary: "nothing here is worth keeping" is a real
      // answer and asking again would not change it.
      return {memories:[], dropped:0, failed:true};
    }
    const written = [];
    for (const item of outcome.memories) {
      // The trace the Stop hook is already inside. Without it a captured
      // memory is the one row in the system whose event cannot name what
      // decided it, which is exactly the row most worth explaining: nobody
      // asked for it.
      try { written.push(await api.captureMemory({id:crypto.randomUUID(), ...item, trace})); }
      catch { /* One bad item must not lose the rest of the turn. */ }
    }
    await api.logRouterRun({id:runId, session_key:sessionKey, model:router.model,
      prompt:outcome.prompt, response:outcome.raw, kept:written.length,
      dropped:outcome.dropped.length, error:null});
    return {memories:written, dropped:outcome.dropped.length, failed:false};
  }
  async function requireScope(projectId, write=false) {
    if (!await result(db.rpc('agent_can_access',{p_project_id:projectId,p_write:write})))
      throw {code:'42501',message:write?'Memory write unavailable':'Memory read unavailable'};
  }
  const api = {
    status: () => result(db.rpc('agent_connection_status')),
    projects: () => result(db.from('projects')
      .select('id,slug,name,brief,revision,updated_at,project_repositories(provider,repository)').order('name')),
    upsertProject: args => result(db.rpc('upsert_project_with_slug',{
      p_slug:args.slug,
      p_request_id:args.request_id,p_project_id:args.project_id,
      p_expected_revision:args.expected_revision??null,p_name:args.name,p_brief:args.brief,
      p_repository_action:args.repository_change.kind,
      p_repository:args.repository_change.repository??null,
    })),
    activeProject: session => result(db.rpc('agent_active_project',{p_session_key:session})),
    repositoryHintExists: session => result(db.rpc('agent_repository_hint_exists',{p_session_key:session})),
    activateRepositoryHint: session => result(db.rpc('activate_agent_repository_hint',{p_session_key:session})),
    // Read only when activation declined to pick, which is when the workspace's
    // repository names more than one project this connection may read. The hint
    // is deliberately left staged in that case so this can still see it.
    repositoryCandidates: session =>
      result(db.rpc('agent_repository_candidates',{p_session_key:session})),
    // The hook scripts' path, and the one that has no staging in it. They hold
    // their own credential, so the caller that knows the repository is also the
    // caller that may resolve it: one authenticated call, no hint row, no
    // expiry, and no poll waiting for an anonymous POST to land.
    //
    // Returns every candidate project, with `selected` true on the one it
    // activated. It only activates when there is exactly one.
    // p_select false asks which projects the repository is linked to without
    // touching the scope. That matters after a /clear, where the session key
    // survives and an explicit select_project made earlier is still active.
    resolveRepository: (session,provider,repository,select=true) =>
      result(db.rpc('resolve_agent_repository',
        {p_session_key:session,p_provider:provider,p_repository:repository,p_select:select})),
    async selectProject(session,projectId) {
      await result(db.rpc('select_agent_project',{p_session_key:session,p_project_id:projectId}));
      return {project_id:projectId};
    },
    async selectRepository(session,provider,repository) {
      const projectId=await result(db.rpc('select_agent_repository',{
        p_session_key:session,p_provider:provider,p_repository:repository,
      }));
      return {project_id:projectId};
    },
    async index(projectId) {
      await requireScope(projectId);
      // A sentinel row detects PostgREST pagination instead of silently claiming completeness.
      const {data:rows,error,count}=await db.rpc('list_memories',{p_project_id:projectId},{count:'exact'})
        .range(0,500).abortSignal(AbortSignal.timeout(8000));
      if(error)throw error;
      return {memories:rows,complete:count!==null&&count===rows.length&&rows.length<501};
    },
    async read(projectId,id) {
      await requireScope(projectId);
      const row=await result(db.rpc('read_memory',{p_project_id:projectId,p_id:id}));
      if (!row) throw {code:'P0002',message:'Memory not found or unavailable'};
      return row;
    },
    async save(args) {
      await requireScope(args.project_id,true);
      const row=await result(db.rpc('save_memory',{p_id:args.id,p_project_id:args.project_id,
        p_statement:args.statement,p_source:args.source??'',p_band:args.band??'said',
        p_name:args.name??null,p_more_info:args.more_info??''}));
      await embedRow(row);
      return row;
    },
    async correct(args) {
      await requireScope(args.project_id,true);
      const row=await result(db.from('memories').select('id,project_id').eq('id',args.id).maybeSingle());
      if (!row || row.project_id!==args.project_id) throw {code:'P0002',message:'Memory not found or unavailable'};
      const updated=await result(db.rpc('correct_memory',{p_id:args.id,p_revision:args.revision,
        p_statement:args.statement,p_name:args.name??null,p_more_info:args.more_info??''}));
      await embedRow(updated);
      return updated;
    },
    async confirm(args) {
      await requireScope(args.project_id,true);
      return result(db.rpc('confirm_memory',{p_id:args.id,p_revision:args.revision}));
    },
    // Retrieval embeds the query and lets the database rank. Scope is a boost
    // rather than a filter, so a first mention of an unrelated project still
    // wins on similarity alone.
    async search(args) {
      if (!embedder) throw {code:'PT503',reason:'search is unavailable: no embedding model is configured for this connection'};
      // The query side. Named rather than passed as a flag so a call site
      // cannot quietly end up on the wrong side of the asymmetry.
      const vector=await embedder.embedQuery(args.query);
      // Omitted, never null. `p_gate real default 0.67` applies when the
      // argument is absent, and JSON null is not absent: it reaches Postgres as
      // NULL, the filter becomes `score >= NULL`, and every row is dropped.
      // That silenced retrieval entirely. The function now coalesces as well,
      // but sending nothing is the honest way to mean "use the default".
      const optional=(key,value)=>value==null?{}:{[key]:value};
      return result(db.rpc('search_memories',{
        p_query:toVectorLiteral(vector),
        p_in_scope:args.in_scope??null,
        p_exclude:args.exclude??[],
        ...optional('p_limit',args.limit),
        ...optional('p_gate',args.gate),
        ...optional('p_boost',args.boost),
      }));
    },
    personal: () => result(db.rpc('personal_memories')),
    // The conversation lives here, not on the user's machine. The per-prompt
    // hook already sends the prompt as a tool argument, so nothing extra is
    // read from disk and no transcript is parsed on either host.
    //
    // One call, two writes, two lifetimes: the 24 hour rolling window the Stop
    // router reads in a few seconds, and the document a consolidation pass
    // reads hours later. They are separate tables on purpose and a single
    // round trip on purpose: the per-prompt hook waits for this one now, and
    // it must not delay the prompt.
    //
    // An empty `content` is not a no-op. It still notes the scope, which is
    // the only thing the end of a turn has to offer on a host that hands us no
    // assistant message.
    recordTurn: (sessionKey, role, content, keep = 12, projectId = null) =>
      result(db.rpc('record_turn',
        {p_session_key:sessionKey, p_role:role, p_content:content,
         p_keep:keep, p_project_id:projectId})),
    sessionWindow: (sessionKey, limit = 12) =>
      result(db.rpc('session_window', {p_session_key:sessionKey, p_limit:limit})),
    // Called only after the router has answered. A run that failed on a rate
    // limit leaves its messages unmarked so the next turn picks them up.
    markSessionClassified: (sessionKey, throughId) =>
      result(db.rpc('mark_session_classified',
        {p_session_key:sessionKey, p_through:throughId})),
    /** Statements the router already produced in this session, so it can be
     *  told not to say them again in different words. Read from router_runs
     *  rather than from memories, which carry no session. That means a
     *  statement validate() then dropped still counts as saved here, which
     *  over-suppresses very slightly and is the safe direction. */
    async capturedThisSession(sessionKey, limit = 20) {
      const rows = await result(db.from('router_runs').select('response')
        .eq('session_key', sessionKey).gt('kept', 0)
        .order('created_at', {ascending:false}).limit(8));
      const statements = [];
      for (const row of rows ?? []) {
        try {
          for (const item of JSON.parse(row.response ?? '{}')?.memories ?? [])
            if (item?.statement) statements.push(String(item.statement));
        } catch { /* A malformed log row must not stop a capture. */ }
      }
      return statements.slice(0, limit);
    },
    clearSessionWindow: sessionKey =>
      result(db.rpc('clear_session_window', {p_session_key:sessionKey})),
    // The document side. Everything the consolidation pass reads, and the two
    // writes it makes that are not memories.
    sessionDocument: async sessionKey => {
      const rows = await result(db.rpc('session_document', {p_session_key:sessionKey}));
      return rows?.[0] ?? null;
    },
    // No limit is sent. Every waiting session is read, and the clock is the
    // only thing that stops a batch early.
    pendingDocuments: (idleMinutes = 30) =>
      result(db.rpc('pending_documents', {p_idle_minutes:idleMinutes})),
    documentTurns: (documentId, after = null) =>
      result(db.rpc('document_content', {p_document_id:documentId, p_after:after})),
    markDocumentConsolidated: (documentId, through) =>
      result(db.rpc('mark_document_consolidated',
        {p_document_id:documentId, p_through:through})),
    // The project's memories and the personal ones together, because a
    // conversation inside a project still produces preferences that belong
    // everywhere, and the pass cannot judge "is this already remembered"
    // against half the set.
    memoriesInScope: (projectId = null, limit = 60) =>
      result(db.rpc('memories_in_scope', {p_project_id:projectId, p_limit:limit})),
    // Ending and extending carry the revision, so a pass working from a list
    // it read a minute ago cannot overwrite something the person changed since.
    endMemory: args => result(db.rpc('end_memory', {
      p_id:args.id, p_revision:args.revision, p_reason:args.reason,
      p_ended_by:args.ended_by ?? null, p_note:args.note ?? null,
      p_trace:args.trace ?? null, p_document:args.document ?? null})),
    async extendMemory(args) {
      const row = await result(db.rpc('extend_memory', {
        p_id:args.id, p_revision:args.revision, p_statement:args.statement,
        p_trace:args.trace ?? null, p_document:args.document ?? null}));
      // The statement changed, so the vector has to. Without this an extended
      // memory keeps matching the words it used to have.
      await embedRow(row);
      return row;
    },
    // Affirming a heard memory also confirms it, so it carries the trace and
    // the conversation the history needs to say where that came from.
    affirmMemory: (id, {trace = null, document = null} = {}) =>
      result(db.rpc('affirm_memory', {p_id:id, p_trace:trace, p_document:document})),
    // What the workspace's repository is up to. The anchor every memory is
    // measured against is derived in the database from this, so nothing has
    // to be threaded through a write.
    // Written back on every scheduled run, because Supabase rotates a refresh
    // token the moment it is used and the copy in the Vault is dead from that
    // instant. Skipping this once means the job never authenticates again.
    rotateConsolidationCredential: refreshToken =>
      result(db.rpc('rotate_consolidation_credential', {p_refresh_token:refreshToken})),
    recordRepositoryHead: (repository, commits, provider = 'github') =>
      result(db.rpc('record_repository_head',
        {p_provider:provider, p_repository:repository, p_commits:commits})),
    // The job a person or the schedule started. A second start while one is
    // running is refused by the unique index, which is the answer rather than
    // an error: the caller is shown the job that is already going.
    async startConsolidationJob({idleMinutes, waiting}) {
      const {data, error} = await db.from('consolidation_jobs')
        .insert({idle_minutes:idleMinutes, waiting}).select('*').abortSignal(AbortSignal.timeout(8000));
      if (error?.code === '23505') return {job:await api.runningConsolidationJob(), started:false};
      if (error) throw error;
      return {job:data[0], started:true};
    },
    runningConsolidationJob: async () => (await result(db.from('consolidation_jobs').select('*')
      .eq('status', 'running').limit(1)))[0] ?? null,
    consolidationJob: async id => (await result(db.from('consolidation_jobs').select('*')
      .eq('id', id).limit(1)))[0] ?? null,
    latestConsolidationJob: async () => (await result(db.from('consolidation_jobs').select('*')
      .order('started_at', {ascending:false}).limit(1)))[0] ?? null,
    // Moves the job only if it is still at the step the caller holds. Null
    // means another call took it over, and the caller must stop.
    moveConsolidationJob: async (id, step, patch) => (await result(db.from('consolidation_jobs')
      .update({...patch, heartbeat_at:new Date().toISOString()})
      .eq('id', id).eq('step', step).eq('status', 'running').select('*')))[0] ?? null,
    async logConsolidationRun(entry) {
      try {
        await result(db.from('consolidation_runs').insert({
          id:entry.id, document_id:entry.document_id ?? null, trace_id:entry.trace_id ?? null,
          model:entry.model, prompt:String(entry.prompt ?? '').slice(0,200000),
          response:entry.response?.slice(0,40000) ?? null, through:entry.through ?? null,
          added:entry.added ?? 0, extended:entry.extended ?? 0, replaced:entry.replaced ?? 0,
          retired:entry.retired ?? 0, affirmed:entry.affirmed ?? 0, dropped:entry.dropped ?? 0,
          input_tokens:entry.input_tokens ?? null, output_tokens:entry.output_tokens ?? null,
          duration_ms:entry.duration_ms ?? null, error:entry.error ?? null,
        }));
      } catch { /* Losing the note is worse than nothing and still not worth failing the run. */ }
    },
    // Slug to UUID happens in the database, so the model never handles an id.
    // One slug, because a memory has one scope and it is a project or
    // personal. There is no task to resolve and nothing that can move the
    // scope after the caller chose it.
    //
    // Embedded here for the same reason save() embeds: a row without a vector
    // is saved and invisible to retrieval. This call did not, and capture is
    // the only writer that never asks anyone afterwards, so nothing noticed.
    // Every automatically captured memory in production was unsearchable, 5
    // of 5, while every explicitly saved one was fine, which is what made it
    // look like a capture-quality problem rather than a missing line.
    async captureMemory(args) {
      const row = await result(db.rpc('capture_memory', {
        p_id:args.id, p_statement:args.statement, p_source:args.source,
        p_project_slug:args.project ?? null, p_kind:args.kind ?? 'fact',
        // Which run wrote this, and which conversation it came out of. Set
        // inside the same transaction as the write, so the event the trigger
        // raises carries them.
        p_trace:args.trace ?? null, p_document:args.document ?? null,
        p_expires:args.expires ?? null,
      }));
      // embedRow swallows its own failures, so a slow or rate-limited embedder
      // still leaves the memory written and the turn counted.
      await embedRow(row);
      return row;
    },
    async logRouterRun(entry) {
      try {
        await result(db.from('router_runs').insert({
          id:entry.id, session_key:entry.session_key, model:entry.model,
          prompt:entry.prompt.slice(0,40000), response:entry.response?.slice(0,40000) ?? null,
          kept:entry.kept, dropped:entry.dropped, error:entry.error ?? null,
        }));
      } catch { /* A capture that cannot be explained is bad; losing the note is worse than nothing but not worth failing the turn. */ }
    },
    // Every column the lifecycle path reads has to be listed here. capture and
    // capture_window were added by the router migration and never added to this
    // select, so settings.capture was undefined on every request, automatic
    // capture short-circuited, and the rolling window the router reads was
    // never written. The defaults below must match the column defaults, or
    // behaviour changes depending on whether a settings row exists.
    async settings() {
      const rows=await result(db.from('memory_settings')
        .select('per_prompt_matches,gate,scope_boost,session_budget_tokens,capture,capture_window,capture_mode,block_size,staleness_commits').limit(1));
      return rows?.[0]??{per_prompt_matches:5,gate:0.67,scope_boost:1.1,
        session_budget_tokens:15000,capture:true,capture_window:5,capture_mode:'session',
        block_size:30,staleness_commits:25};
    },
    // The log is what turns "why did it not know that" into a query, and it is
    // the trigger for every deferred decision in the design. A failure to log
    // must never fail the injection it was recording.
    async logInjection(entry) {
      try {
        await result(db.from('memory_injections').insert({
          id:entry.id,session_key:entry.session_key,event:entry.event,
          query:entry.query?.slice(0,2000)??null,memory_ids:entry.memory_ids.slice(0,50),
          matched:entry.matched,in_scope:entry.in_scope,tokens:entry.tokens,
        }));
      } catch { /* Losing a log row is not worth losing the context it describes. */ }
    },
    // An agent's forget ends the memory, the same as the web app's Forget: the
    // row and its history stay, and the archive can bring it back. The one real
    // delete is a person's. end_memory takes an id alone, so the select keeps
    // the scope the agent named authoritative rather than any scope it can write.
    async forget(args) {
      await requireScope(args.project_id,true);
      let query=db.from('memories').select('id').eq('id',args.id);
      query=args.project_id===null?query.is('project_id',null):query.eq('project_id',args.project_id);
      if (!(await result(query)).length) throw {code:'PT409',message:'Memory changed or unavailable'};
      const row=await api.endMemory({id:args.id,revision:args.revision,reason:'forgotten'});
      return {forgotten_id:row.id,revision:row.revision};
    },
    captureTurn: router ? captureTurn : null,
  };
  return api;
}
