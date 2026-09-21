import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {sessionStartBlock, promptBlock, estimateTokens, noticeFor} from './injection-format.mjs';
import {traced, retrieval} from './tracing.mjs';

const scope=z.uuid().nullable().describe('null means personal memory; otherwise an explicitly selected project UUID.');
const session=z.string().min(1).max(200);
// A memory is one sentence. `source` is the span the user actually typed and is
// stored for provenance, never injected. `band` is not a judgement call: an
// explicit save is 'said', a captured one is 'heard'.
const content={
  statement:z.string().trim().min(1).max(500).describe('The memory, as one readable sentence that will still make sense in six weeks.'),
  source:z.string().max(4000).default('').describe("The user's own words this was drawn from. Stored for provenance and never injected."),
  name:z.string().trim().min(1).max(100).nullable().default(null).describe('An optional handle. Most memories have none.'),
  more_info:z.string().max(40000).default(''),
};
const identity={project_id:scope,id:z.uuid(),revision:z.number().int().positive()};
const readAnnotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
const writeAnnotations={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const lifecycle=z.enum(['SessionStart','PostCompact','UserPromptSubmit','Stop']);
// Only the server-side link table maps a repository to a project, so the provider stays implicit.
const PROVIDER='github';
const repositoryName=z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/).max(201).nullable()
  .describe('Normalized lowercase owner/repository detected by the Satchel bootstrap, never a guessed folder name.');
const projectRepositoryChange=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('unchanged')}),
  z.object({kind:z.literal('link'),repository:z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/).max(201)}),
  z.object({kind:z.literal('unlink'),repository:z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/).max(201)}),
]);
// Supplied, never derived. A model copies an identifier and rewrites a title,
// so the exact match has to be on something that looks like an identifier.
const slug=z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).min(1).max(40)
  .describe('A short handle the user would actually say, like fix-consent-layout. Lowercase words joined by hyphens, unique across all of this user\'s projects and tasks. Do not derive it from the title; choose something sayable. On 23505 pick another and retry.');
const taskStatus=z.enum(['inbox','ready','in_progress','blocked','done']);
const taskPriority=z.enum(['low','medium','high','urgent']);
const taskProject=z.uuid().nullable().describe('null means personal tasks; otherwise an explicitly task-authorized Satchel project UUID.');
const taskIdentity={project_id:taskProject,id:z.uuid(),revision:z.number().int().positive()};
const taskContent={
  title:z.string().trim().min(1).max(200),outcome:z.string().max(1000).default(''),
  why:z.string().max(4000).default(''),done_when:z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  next_action:z.string().max(1000).default(''),priority:taskPriority.default('medium'),
};
const taskEdit=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('content'),...taskContent}),
  z.object({kind:z.literal('state'),status:taskStatus,blocked_reason:z.string().max(2000).default('')}),
  z.object({kind:z.literal('parent'),parent_id:z.uuid().nullable()}),
  z.object({kind:z.literal('add_dependency'),depends_on_task_id:z.uuid()}),
  z.object({kind:z.literal('remove_dependency'),depends_on_task_id:z.uuid()}),
]);
const updateList=z.array(z.string().trim().min(1).max(1000)).max(50).default([]);
const taskUpdate=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('comment'),entry_id:z.uuid(),body:z.string().trim().min(1).max(4000),
    resource_ids:z.array(z.uuid()).max(50).default([])}),
  z.object({kind:z.literal('progress'),entry_id:z.uuid(),revision:z.number().int().positive(),
    summary:z.string().trim().min(1).max(4000),completed:updateList,decisions:updateList,
    remaining:updateList,blockers:updateList,next_action:z.string().max(1000).nullable().default(null),
    status:taskStatus.nullable().default(null),blocked_reason:z.string().max(2000).default(''),
    resource_ids:z.array(z.uuid()).max(50).default([])}),
  z.object({kind:z.literal('handoff'),entry_id:z.uuid(),revision:z.number().int().positive(),
    supersedes_ids:z.array(z.uuid()).max(20).default([]),completed:updateList,decisions:updateList,
    validation:z.array(z.record(z.string(),z.unknown())).max(50).default([]),remaining:updateList,
    blockers:updateList,next_action:z.string().trim().min(1).max(1000),summary:z.string().max(4000).default(''),
    status:taskStatus.nullable().default(null),blocked_reason:z.string().max(2000).default(''),
    resource_ids:z.array(z.uuid()).max(50).default([])}),
]);
const textResult=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
// A failure that can say what it was says it. Everything from the embedder and
// the router carries a plain-words `reason`, because routing those through the
// code table below produced "Satchel request failed. Reload before retrying a
// write: it may have completed" for a spent embedding quota: unhelpful, and
// also untrue, since nothing was written.
const errorText=error=>error?.reason
  ?(error.reason.charAt(0).toUpperCase()+error.reason.slice(1)).replace(/\.?$/,'.')
  :({
  '42501':'Access denied. Check the connection and granted memory or task scopes in Satchel.',
  'P0002':'The requested Satchel record is unavailable. Refresh before trying again.',
  'PT400':'Provide exactly one of project_id (null for personal scope) or repository.',
  'PT404':'That repository is not linked to a project in this connection\'s grant. Report that project memory was not loaded; do not guess a project.',
  'PT409':'Revision or request conflict. Read the current record; do not overwrite blindly.',
  'PT300':'That repository belongs to more than one project, so it does not name one. Call list_projects and select_project with an explicit project_id.',
  '23505':'This name is already used in the selected scope.',
  '23514':'The supplied fields or relationships violate the Satchel contract.',
}[error?.code] ?? 'Satchel request failed. Reload before retrying a write: it may have completed.');

// ownerId attributes a trace to the person and nothing more: never an email,
// never a token.
export function createMemoryServer(service, {ownerId} = {}) {
  const server=new McpServer({name:'satchel',title:'Satchel',version:'0.2.0',
    websiteUrl:'https://satchel-pi.vercel.app',
    description:'Your memory, tasks and projects, across your agents.',
    icons:[
      {src:'https://satchel-pi.vercel.app/mark.svg',mimeType:'image/svg+xml',sizes:['any']},
      {src:'https://satchel-pi.vercel.app/mark-512.png',mimeType:'image/png',sizes:['512x512']},
    ]});
  // The bootstrap stages the workspace's repository at SessionStart and this is
  // the only thing that reads it. It used to read it on SessionStart alone,
  // which is the source the mcp_tool hook is skipped on at launch, so the note
  // sat unread for the whole session: active_project stayed null, capture had
  // no scope to hand the router, and everything went to personal.
  //
  // Polling is for SessionStart only, where this races the bootstrap's own POST
  // to the staging endpoint. On any later event that POST finished long ago, so
  // one look is enough, and UserPromptSubmit has a five second hook budget that
  // 3.25s of polling would eat.
  async function consumeLifecycleHint(sessionKey,event) {
    const attempts=['SessionStart','PostCompact'].includes(event)?13:1;
    for(let attempt=0;attempt<attempts;attempt++) {
      if(await service.repositoryHintExists(sessionKey))
        return {staged:true,project:await service.activateRepositoryHint(sessionKey)};
      if(attempt<attempts-1)await new Promise(resolve=>setTimeout(resolve,250));
    }
    return {staged:false};
  }
  /** The scope this conversation is in, activating a pending repository hint
   *  first. Deterministic whenever it can be: the workspace's git remote
   *  resolves to a project through project_repositories and no model is asked
   *  to guess it.
   *
   *  A repository may name more than one project, because a project is a
   *  collection of context and a monorepo holds several of them. When it does,
   *  the hint stays staged and this returns the candidates instead of a scope.
   *  Picking one arbitrarily would put a memory in a real project that is the
   *  wrong project, which is worse than personal: personal is at least visible
   *  everywhere and obviously unscoped. */
  async function scopeFor(sessionKey,event,selected) {
    if(selected!==undefined)return {project:selected,candidates:[]};
    const active=await service.activeProject(sessionKey);
    if(active)return {project:active,candidates:[]};
    const hint=await consumeLifecycleHint(sessionKey,event);
    if(hint.project)return {project:hint.project,candidates:[]};
    if(!hint.staged)return {project:null,candidates:[]};
    // Staged but unresolved is the ambiguous case. Anything else is a workspace
    // with no linked project at all, where there is nothing to offer.
    const candidates=await service.repositoryCandidates?.(sessionKey)??[];
    return {project:null,candidates};
  }
  /** What the model is told when its workspace could be either of two projects.
   *  Named by slug, chosen by project_id, because the id is what select_project
   *  takes and a slug it had to look up is a second place to go wrong. */
  const chooseProjectLine=candidates=>candidates.length<2?'':
    `\nThis workspace's repository belongs to ${candidates.length} projects: `
    +candidates.map(c=>`${c.slug} (${c.project_id})`).join(', ')
    +`. Nothing is scoped to a project until you call select_project with one of those project_id values.`
    +` Do not guess, and do not treat memory as project-scoped before then.`;
  // Shared by explicit selection and the lifecycle hook so both report the same scope.
  async function scopedIndex(project,status) {
    const scopes=[...(status.personal?[null]:[]),...(project?[project]:[])];
    const indexes=await Promise.all(scopes.map(target=>service.index(target)));
    return {active_project:project,personal_included:scopes.includes(null),
      memories:indexes.flatMap(x=>x.memories),complete:indexes.every(x=>x.complete)};
  }
  // A hook placeholder that did not substitute arrives as its own literal text.
  // Treating that as a query would search for "${user_prompt}" on every turn,
  // so anything still shaped like a placeholder is discarded and the other
  // spelling is used instead.
  const substituted=value=>{
    const text=typeof value==='string'?value.trim():'';
    return /^\$\{[^}]*\}$/.test(text)?'':text;
  };
  const resolvePrompt=options=>substituted(options.prompt)||substituted(options.user_prompt);

  // Injected context is unrequested, so it is budgeted and it says what it is.
  // Session start carries only what applies no matter what you do today: the
  // projects that exist, and every personal memory. Anything scoped to a
  // project or a task is earned by something the user said, and arrives
  // through UserPromptSubmit instead.
  async function contextPayload(sessionKey,event,selectedProject,options={}) {
    // One trace per lifecycle event, grouped by conversation. The session is
    // what makes a capture explicable later: you can see the retrievals that
    // preceded it in the same session view.
    return traced(`satchel.${event}`,
      {sessionId:sessionKey,userId:ownerId,metadata:{event},tags:['satchel',event],
       input:event==='UserPromptSubmit'?resolvePrompt(options):null},
      (setOutput,setInput)=>buildContext(sessionKey,event,selectedProject,options,setOutput,setInput));
  }
  async function buildContext(sessionKey,event,selectedProject,options,setOutput=()=>{},setInput=()=>{}) {
    let context;
    let logged=null;
    // What the person sees, as opposed to what the model sees. Kept separate
    // the whole way down: a failure has to reach them even when the model is
    // told nothing, which is every Stop and every quiet prompt.
    let notice='';
    try {
      const status=await service.status();
      if (!status) throw {code:'42501'};
      const settings=await service.settings();
      if (event==='Stop') {
        // Capture, and nothing injected. Claude Code can inject from Stop and
        // Codex cannot, so a design that used it would work on one host only,
        // and the next turn may change subject anyway.
        // Codex has no last_assistant_message, so on that host the placeholder
        // arrives as its own literal text. Recording it would put the string
        // "${last_assistant_message}" into the window the router reads on
        // every single turn.
        const assistant=substituted(options.last_assistant_message);
        if (assistant) void service.recordSessionMessage(sessionKey,'assistant',assistant);
        if (!settings.capture||!service.captureTurn) return null;
        const window=await service.sessionWindow(sessionKey,settings.capture_window*2);
        const ordered=[...window].reverse();
        // The turn is exactly what has not been classified yet, which is a
        // boundary rather than a guess. It used to be the last capture_window
        // user messages, so with the default of 5 every Stop re-offered the
        // last five and consecutive Stops overlapped by four. Anything durable
        // got five chances and was duly saved twice.
        const start=ordered.findIndex(m=>m.classified_at==null&&m.role==='user');
        if (start===-1) return null;
        const turn=ordered.slice(start).filter(m=>m.role==='user').map(m=>m.content);
        if (!turn.length) return null;
        // The turn being classified is the only thing that may supply a source.
        // Everything before it is there to understand it. Named `earlier` and
        // not `context`: a block-scoped `context` here shadows the outer one
        // for the whole block, and reading it before its declaration threw a
        // ReferenceError that the catch below swallowed, so capture silently
        // never ran.
        const earlier=ordered.slice(0,start);
        // The turn is what this trace is actually about, and it is only known
        // now, so the input is replaced rather than left as the event name.
        setInput({turn,contextMessages:earlier.length});
        // Scope is resolved, not inferred. The workspace's git remote already
        // maps to a project through project_repositories, and handing the
        // router a flat list with nothing saying which one the conversation was
        // in is why a memory about this project's own deployment key was filed
        // under personal.
        const {project:scope}=await scopeFor(sessionKey,event,selectedProject);
        const [projects,tasks,saved]=await Promise.all([
          service.projects(),service.openTasks(),
          service.capturedThisSession?.(sessionKey)??[]]);
        const active=projects.find(p=>p.id===scope)??null;
        // Named only when it is unambiguous. A project may link to several
        // repositories, and naming an arbitrary one of them would be worse
        // than naming none.
        const links=active?.project_repositories??[];
        const capture=await service.captureTurn(sessionKey,{
          codebase:links.length===1?links[0].repository:null,
          project:active?{slug:active.slug,brief:active.brief}:null,
          projects:projects.filter(p=>p.id!==scope).map(p=>({slug:p.slug,brief:p.brief})),
          tasks:tasks.map(t=>({slug:t.slug,title:t.title,project:projects.find(p=>p.id===t.project_id)?.slug??null})),
          context:earlier,turn,saved});
        // The boundary moves only when the model actually answered. A run that
        // died on a rate limit leaves its messages for the next turn.
        const through=ordered[ordered.length-1]?.id;
        if (capture&&!capture.failed&&through!=null)
          void service.markSessionClassified?.(sessionKey,through);
        notice=noticeFor('Stop',{captured:capture?.memories?.length??0});
        return notice?{hookSpecificOutput:{hookEventName:event,additionalContext:''},systemMessage:notice}:null;
      }
      if (event==='UserPromptSubmit') {
        const prompt=resolvePrompt(options);
        if (!prompt) return null;
        // Recorded whether or not anything is retrieved, because the window the
        // router reads is built from exactly this.
        if (settings.capture) void service.recordSessionMessage(sessionKey,'user',prompt,settings.capture_window*2);
        if (!settings.per_prompt_matches) return null;
        const {project}=await scopeFor(sessionKey,event,selectedProject);
        const lookup=retrieval('retrieve-memory',{input:prompt,
          metadata:{gate:settings.gate,limit:settings.per_prompt_matches,
            inScope:project??'personal',excluded:(options.exclude??[]).length}});
        let rows;
        try { rows=await service.search({query:prompt,in_scope:project??null,
          limit:settings.per_prompt_matches,gate:settings.gate,boost:settings.scope_boost,
          exclude:options.exclude??[]}); }
        catch (error) { lookup.fail(error); throw error; }
        lookup.end(rows.map(r=>({id:r.id,statement:r.statement,score:r.score})),
          {metadata:{shown:rows.length,matched:rows[0]?.matched??0,inScope:rows[0]?.in_scope??0}});
        if (!rows.length) return null;
        notice=noticeFor('UserPromptSubmit',{shown:rows.length,matched:rows[0].matched});
        const tasks=await service.tasksByIds?.(rows.map(r=>r.task_id).filter(Boolean))??new Map();
        const block=promptBlock({rows,matched:rows[0].matched,inScope:rows[0].in_scope,tasks});
        logged={query:prompt,memory_ids:rows.map(r=>r.id),
          matched:rows[0].matched,in_scope:rows[0].in_scope,tokens:estimateTokens(block)};
        context=block;
      } else {
        const {project,candidates}=await scopeFor(sessionKey,event,selectedProject);
        const [projects,personal]=await Promise.all([
          // all_projects is its own scope: a blanket grant keeps no list, so
          // checking project_ids alone would load nothing for the connection
          // that was given everything.
          status.all_projects||status.project_ids?.length||status.personal?service.projects():[],
          status.personal?service.personal():[],
        ]);
        const block=sessionStartBlock({projects,personal});
        const tokens=estimateTokens(block);
        notice=noticeFor('SessionStart',{projects:projects.length,personal:personal.length});
        if (!block) {
          context='Satchel is connected and has nothing saved yet. Do not invent memory.';
        } else if (tokens>settings.session_budget_tokens) {
          // Withheld rather than truncated: a partial block that looks complete
          // is worse than an honest absence, because the agent cannot tell.
          context=`Satchel memory NOT loaded: ${tokens} tokens exceeds the ${settings.session_budget_tokens} budget for this session. Use retrieve_memory for anything you need; do not claim memory loaded.`;
          notice=noticeFor(event,{withheld:`${tokens} tokens over the ${settings.session_budget_tokens} budget`});
        } else {
          context=block;
          logged={query:null,memory_ids:personal.map(m=>m.id),matched:personal.length,
            in_scope:personal.length,tokens};
        }
        if (project) context+=`\nactive project: ${project}`;
        else context+=chooseProjectLine(candidates);
      }
    } catch(error) {
      context='Satchel memory unavailable. '+errorText(error)+' Do not claim that memory loaded.';
      notice=noticeFor(event,{error:errorText(error)});
    }
    if (logged) void service.logInjection({id:crypto.randomUUID(),session_key:sessionKey,event,...logged});
    // The exact bytes the model receives, so a trace answers "what did it
    // actually see" rather than "what did we intend to send".
    setOutput(context);
    // Stop never injects, on either host, so a failure there reaches the
    // person and no one else.
    return {hookSpecificOutput:{hookEventName:event,additionalContext:event==='Stop'?'':context},
      ...(notice?{systemMessage:notice}:{})};
  }
  function register(name,description,inputSchema,operation,annotations=readAnnotations) {
    server.registerTool(name,{description,inputSchema,annotations},async args=>{
      try {
        const status=await service.status();
        if (!status) throw {code:'42501'};
        return textResult(await operation(args,status));
      } catch(error) { return {...textResult({error:errorText(error)}),isError:true}; }
    });
  }
  register('list_projects','Show effective Satchel connection permissions and only the projects this connection may access. Personal scope is project_id=null; a project is an explicit UUID from this list, never a directory name.',
    {},async (_args,{project_ids,...connection})=>{
      // Diagnosing a broken connection must not depend on the project query succeeding.
      try { return {...connection,projects:await service.projects()}; }
      catch(error) { return {...connection,projects_error:errorText(error)}; }
    });
  register('upsert_project','Create or revise a Satchel project only when the user explicitly asks. A slug is required and is how everything else refers to this project. Omit expected_revision to create with a new project_id; provide the current revision to update an already authorized project. A repository change links or unlinks one normalized GitHub owner/repository without disturbing other links. Creating a project never expands this connection grant: when grant_required is true, tell the user to authorize the new project before using it.',
    {request_id:z.uuid(),project_id:z.uuid(),slug,expected_revision:z.number().int().positive().optional(),
      name:z.string().trim().min(1).max(100),brief:z.string().trim().max(1000).default(''),
      repository_change:projectRepositoryChange.default({kind:'unchanged'})},
    a=>service.upsertProject(a),writeAnnotations);
  register('select_project','Select the active project for this conversation only, by project_id (null selects personal scope) or by the linked GitHub repository identity supplied by the Satchel bootstrap. Provide exactly one; a repository resolves only to a link whose project is already in this connection\'s grant, and only while it names one project: a repository shared by several projects is refused, so pass project_id for those. Returns the resulting personal plus project memory index: check complete before claiming all memories loaded. Pass event only when the Satchel bootstrap asks for it on a new conversation or after compaction. Does not grant permissions and does not change another conversation.',
    {session_key:session,project_id:scope.optional(),repository:repositoryName.optional(),event:lifecycle.optional()},
    async (a,status)=>{
      const byRepository=a.repository!=null,byProject=a.project_id!==undefined;
      if (byProject===byRepository) throw {code:'PT400'};
      // Personal scope on a connection without a personal grant is a denial, not an empty index.
      if (byProject&&a.project_id===null&&!status.personal) throw {code:'42501'};
      const {project_id}=byRepository
        ? await selectRepositoryScope(a.session_key,a.repository)
        : await service.selectProject(a.session_key,a.project_id);
      if (a.event) return contextPayload(a.session_key,a.event,project_id);
      // The scope change is already committed, so an index failure must not read as a failed selection.
      try { return await scopedIndex(project_id,status); }
      catch(error) { return {active_project:project_id,selected:true,index_error:errorText(error)}; }
    },writeAnnotations);
  async function selectRepositoryScope(sessionKey,repository) {
    try { return await service.selectRepository(sessionKey,PROVIDER,repository); }
    catch(error) { throw error?.code==='P0002'?{code:'PT404'}:error; }
  }
  register('memory_index','List whole memories in one explicit scope. Each row carries its full statement, so there is nothing further to fetch unless has_more_info is true. Check complete before claiming all memories loaded.',
    {project_id:scope},a=>service.index(a.project_id));
  register('retrieve_memory','Search memories by meaning across every scope this connection may read. Use this rather than reading a whole scope. Returns the closest matches above a relevance floor, with counts: matched is how many cleared the floor and in_scope is how many were searched, so "nothing relevant" is distinguishable from "nothing scored". Pass in_scope with the project the conversation is working in to weight it slightly; it is a nudge, not a filter.',
    {query:z.string().trim().min(1).max(2000),in_scope:z.uuid().nullable().default(null),
      limit:z.number().int().min(1).max(20).default(5),
      exclude:z.array(z.uuid()).max(50).default([]).describe('Memory ids already in this conversation, so nothing is injected twice.')},
    a=>service.search(a));
  register('read_memory','Read the rare memory that carries more_info, by scope and id. The index already contains every statement, so this is only for a row whose has_more_info is true.',
    {project_id:scope,id:z.uuid()},a=>service.read(a.project_id,a.id));
  register('save_memory','Save memory only when the user explicitly asks. Choose personal/project scope explicitly. Supply a new UUID and reuse that UUID and payload when retrying the same save. An explicit save is confirmed by definition, so it is stored as said.',
    {project_id:scope,id:z.uuid(),task_id:z.uuid().nullable().default(null)
      .describe('Only when the user tied this to a task that is already in the same scope.'),...content},
    a=>service.save({...a,band:'said'}),writeAnnotations);
  register('correct_memory','Correct memory only on an explicit user request. Read first and provide the current revision; conflicts require re-reading. Correcting a memory also confirms it.',
    {...identity,...content},a=>service.correct(a),{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false});
  register('confirm_memory','Promote an unconfirmed memory to confirmed, after the user has agreed it is right. Only ever call this when they actually said so.',
    identity,a=>service.confirm(a),writeAnnotations);
  register('delete_memory','Delete only a memory the user explicitly requested to forget; provide its scope, ID and current revision.',
    identity,a=>service.remove(a),{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false});

  if(service.tasks) {
    register('list_tasks','List bounded task summaries in one explicit task scope. Use project_id=null for personal tasks; otherwise use an authorized project UUID. Filter by state when useful and check complete before claiming the list is exhaustive.',
      {project_id:taskProject,statuses:z.array(taskStatus).max(5).optional()},a=>service.tasks.list(a.project_id,a.statuses));
    register('read_task','Read one task with its planning relationships, derived actionability, comments, progress updates, handoffs, verified resources, and event history.',
      {project_id:taskProject,id:z.uuid()},a=>service.tasks.read(a.project_id,a.id));
    register('create_task','Create a personal or project Satchel task only when the user explicitly asks. A slug is required: it is how the user and you will refer to this task later. Use project_id=null for personal scope. Reuse request_id and id with the identical payload when retrying a lost response.',
      {request_id:z.uuid(),id:z.uuid(),slug,project_id:taskProject,...taskContent},a=>service.tasks.create(a),writeAnnotations);
    register('edit_task','Apply one explicit revision-safe task edit: replace content, transition state, set/clear the parent, or add/remove one dependency. Relationship edits are same-scope and cycle-safe. Re-read after a conflict.',
      {request_id:z.uuid(),...taskIdentity,change:taskEdit},a=>{
        const base={request_id:a.request_id,project_id:a.project_id,id:a.id,revision:a.revision};
        if(a.change.kind==='content')return service.tasks.update({...base,...a.change});
        if(a.change.kind==='state')return service.tasks.transition({...base,...a.change});
        if(a.change.kind==='parent')return service.tasks.setParent({...base,...a.change});
        if(a.change.kind==='add_dependency')return service.tasks.addDependency({...base,...a.change});
        return service.tasks.removeDependency({...base,...a.change});
      },writeAnnotations);
    register('record_task_update','Append one continuation entry: a lightweight comment, structured progress, or a handoff. Progress and handoffs require the current revision because they update canonical task state; comments do not.',
      {request_id:z.uuid(),project_id:taskProject,id:z.uuid(),entry:taskUpdate},a=>{
        const base={request_id:a.request_id,project_id:a.project_id,id:a.id};
        if(a.entry.kind==='comment')return service.tasks.comment({...base,...a.entry,update_id:a.entry.entry_id});
        if(a.entry.kind==='progress')return service.tasks.progress({...base,...a.entry,update_id:a.entry.entry_id});
        return service.tasks.handoff({...base,...a.entry,handoff_id:a.entry.entry_id});
      },writeAnnotations);
    register('add_task_resource','Attach a typed HTTPS reference to a task. This stores the link only and never fetches its contents.',
      {request_id:z.uuid(),resource_id:z.uuid(),...taskIdentity,label:z.string().trim().min(1).max(200),
        url:z.url({protocol:/^https$/}),resource_type:z.enum(['reference','document','image','artifact','repository','pull_request']).default('reference'),
        provider:z.string().trim().max(80).nullable().default(null)},a=>service.tasks.addResource(a),writeAnnotations);
  }

  // This tool is deliberately read-only. Only our formatter controls hook JSON.
  // Read only, and the only thing that formats hook output. On
  // UserPromptSubmit the prompt is the search query and nothing else; no
  // transcript, no assistant text, and nothing is written.
  server.registerTool('load_memory_context',{
    description:'Lifecycle hook. At session start and after compaction it injects the projects list and every personal memory. On UserPromptSubmit it retrieves memories relevant to that prompt. On Stop it reviews the turn that just ended and may record a memory the user stated, which arrives unconfirmed. It never stores the conversation itself beyond a short rolling window used for that review.',
    inputSchema:{session_key:session,event:lifecycle,
      prompt:z.string().max(2000).optional().describe('Only for UserPromptSubmit: the prompt to retrieve against.'),
      last_assistant_message:z.string().max(8000).optional().describe('Only for Stop, where the host provides it: the final assistant text of the turn.'),
      user_prompt:z.string().max(2000).optional().describe('The same thing under the other host spelling; whichever actually carries text is used.'),
      exclude:z.array(z.uuid()).max(50).default([])},
    annotations:readAnnotations,
  },async ({session_key,event,prompt,user_prompt,last_assistant_message,exclude})=>{
    const payload=await contextPayload(session_key,event,undefined,
      {prompt,user_prompt,last_assistant_message,exclude});
    // Nothing relevant is a real answer. Returning an empty result keeps the
    // per-prompt cost at zero on the turns that need nothing.
    return textResult(payload??{hookSpecificOutput:{hookEventName:event,additionalContext:''}});
  });
  return server;
}
