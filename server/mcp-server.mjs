import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {errorText} from './error-text.mjs';
import {sessionStart} from './lifecycle.mjs';
import {traced} from './tracing.mjs';

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
const lifecycle=z.enum(['SessionStart','PostCompact']);
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
  // Shared by explicit selection and the lifecycle hook so both report the same scope.
  async function scopedIndex(project,status) {
    const scopes=[...(status.personal?[null]:[]),...(project?[project]:[])];
    const indexes=await Promise.all(scopes.map(target=>service.index(target)));
    return {active_project:project,personal_included:scopes.includes(null),
      memories:indexes.flatMap(x=>x.memories),complete:indexes.every(x=>x.complete)};
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
      // The recovery path, for a session whose hook could not run. Same code
      // the hook endpoint calls, so what it returns is what the hook would have
      // injected.
      if (a.event) {
        const loaded=await sessionStart(service,{sessionKey:a.session_key,event:a.event,
          project:project_id,ownerId,traced});
        return {hookSpecificOutput:{hookEventName:a.event,additionalContext:loaded.context},
          ...(loaded.notice?{systemMessage:loaded.notice}:{})};
      }
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
  // A memory has one scope: a project, or personal. There is no task_id any
  // more, so this takes three decisions instead of four and none of them can
  // move the scope after it was chosen.
  register('save_memory','Save memory only when the user explicitly asks. Choose personal/project scope explicitly. Supply a new UUID and reuse that UUID and payload when retrying the same save. An explicit save is confirmed by definition, so it is stored as said.',
    {project_id:scope,id:z.uuid(),...content},
    a=>service.save({...a,band:'said'}),writeAnnotations);
  register('correct_memory','Correct memory only on an explicit user request. Read first and provide the current revision; conflicts require re-reading. Correcting a memory also confirms it.',
    {...identity,...content},a=>service.correct(a),{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false});
  register('confirm_memory','Promote an unconfirmed memory to confirmed, after the user has agreed it is right. Only ever call this when they actually said so.',
    identity,a=>service.confirm(a),writeAnnotations);
  // Named for what it does. It ends the memory as forgotten and keeps the row
  // and its history, so the person can restore it from the archive; nothing an
  // agent can call destroys a memory.
  register('forget_memory','Forget only a memory the user explicitly asked to forget; provide its scope, ID and current revision. It stops loading and matching right away and moves to the archive in the Satchel app, where the user can restore it. On a conflict, re-read.',
    identity,a=>service.forget(a),{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false});

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

  return server;
}
