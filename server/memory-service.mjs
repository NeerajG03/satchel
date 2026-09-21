import {indexedText, toVectorLiteral} from './embedding.mjs';

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
  async function captureTurn(sessionKey, {projects, tasks, context, turn}) {
    const runId = crypto.randomUUID();
    let outcome;
    try {
      outcome = await router.route({projects, tasks, context, turn});
    } catch (error) {
      await api.logRouterRun({id:runId, session_key:sessionKey, model:router.model,
        prompt:'(not sent)', response:null, kept:0, dropped:0, error:String(error.message ?? error)});
      return {memories:[], dropped:0};
    }
    const written = [];
    for (const item of outcome.memories) {
      try { written.push(await api.captureMemory({id:crypto.randomUUID(), ...item})); }
      catch { /* One bad item must not lose the rest of the turn. */ }
    }
    await api.logRouterRun({id:runId, session_key:sessionKey, model:router.model,
      prompt:outcome.prompt, response:outcome.raw, kept:written.length,
      dropped:outcome.dropped.length, error:null});
    return {memories:written, dropped:outcome.dropped.length};
  }
  async function requireScope(projectId, write=false) {
    if (!await result(db.rpc('agent_can_access',{p_project_id:projectId,p_write:write})))
      throw {code:'42501'};
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
      if (!row) throw {code:'P0002'};
      return row;
    },
    async save(args) {
      await requireScope(args.project_id,true);
      const row=await result(db.rpc('save_memory',{p_id:args.id,p_project_id:args.project_id,
        p_statement:args.statement,p_source:args.source??'',p_band:args.band??'said',
        p_task_id:args.task_id??null,p_name:args.name??null,p_more_info:args.more_info??''}));
      await embedRow(row);
      return row;
    },
    async correct(args) {
      await requireScope(args.project_id,true);
      const row=await result(db.from('memories').select('id,project_id').eq('id',args.id).maybeSingle());
      if (!row || row.project_id!==args.project_id) throw {code:'P0002'};
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
      if (!embedder) throw {code:'PT503'};
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
    // The rolling window lives here, not on the user's machine. The per-prompt
    // hook already sends the prompt as a tool argument, so nothing extra is
    // read from disk and no transcript is parsed on either host.
    recordSessionMessage: (sessionKey, role, content, keep = 12) =>
      result(db.rpc('record_session_message',
        {p_session_key:sessionKey, p_role:role, p_content:content, p_keep:keep})),
    sessionWindow: (sessionKey, limit = 12) =>
      result(db.rpc('session_window', {p_session_key:sessionKey, p_limit:limit})),
    clearSessionWindow: sessionKey =>
      result(db.rpc('clear_session_window', {p_session_key:sessionKey})),
    async openTasks() {
      const rows = await result(db.from('task_planning').select('slug,title,project_id')
        .neq('status','done').order('last_activity_at',{ascending:false}).limit(12));
      return rows ?? [];
    },
    // Slug to UUID happens in the database, so the model never handles an id.
    captureMemory: args => result(db.rpc('capture_memory', {
      p_id:args.id, p_statement:args.statement, p_source:args.source,
      p_project_slug:args.project ?? null, p_task_slug:args.task ?? null,
    })),
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
        .select('per_prompt_matches,gate,scope_boost,session_budget_tokens,capture,capture_window').limit(1));
      return rows?.[0]??{per_prompt_matches:5,gate:0.67,scope_boost:1.1,
        session_budget_tokens:15000,capture:true,capture_window:5};
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
    async remove(args) {
      await requireScope(args.project_id,true);
      let query=db.from('memories').delete().eq('id',args.id).eq('revision',args.revision);
      query=args.project_id===null?query.is('project_id',null):query.eq('project_id',args.project_id);
      const rows=await result(query.select('id'));
      if (!rows.length) throw {code:'PT409'};
      return {deleted_id:args.id};
    },
    captureTurn: router ? captureTurn : null,
  };
  return api;
}
