import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {generateKeyPair,SignJWT} from 'jose';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {verifyAgentToken,RESOURCE,SUPABASE_URL} from '../server/http-handler.mjs';
import {taskService} from '../server/task-service.mjs';

test('MCP contracts separate index, detail, explicit writes and hook output',async()=>{
  const id=crypto.randomUUID(),projectId=crypto.randomUUID();let revoked=false,writes=0,projectWrites=0,oversized=false,detailReads=0,activations=0,hintedProject=null,unlinked=false,personal=true;
  const searches=[],logged=[];let retrieval=[];
  const summary={id,project_id:null,name:'fixture',statement:'Read for fixture colour',band:'said',task_id:null,revision:1};
  const projectSummary={...summary,id:crypto.randomUUID(),project_id:projectId,name:'project-fixture'};
  const service={status:async()=>revoked?null:{label:'Test',personal,can_write:true,project_ids:[projectId]},
    activeProject:async()=>null,
    projects:async()=>[{id:projectId,name:'Fixture',brief:''}],
    upsertProject:async a=>{projectWrites++;return {project:{id:a.project_id,name:a.name,brief:a.brief,revision:1},repositories:[],grant_required:true};},
    repositoryHintExists:async()=>hintedProject!==null,
    activateRepositoryHint:async()=>hintedProject,
    selectProject:async(_session,project)=>({project_id:project}),
    selectRepository:async()=>{activations++;if(unlinked)throw {code:'P0002'};return {project_id:projectId};},
    index:async project=>({memories:oversized?[{...summary,statement:'x'.repeat(8000)}]:[project?projectSummary:summary],complete:true}),
    read:async()=>{detailReads++;return {...summary,more_info:'amber'};},
    settings:async()=>({per_prompt_matches:5,gate:0.62,scope_boost:1.1,session_budget_tokens:oversized?1000:15000}),
    personal:async()=>oversized
      ?Array.from({length:400},(_,i)=>({...summary,id:crypto.randomUUID(),statement:'x'.repeat(200)+i}))
      :[summary],
    search:async a=>{searches.push(a);return retrieval;},
    logInjection:async entry=>{logged.push(entry);},
    save:async a=>{writes++;service.lastSave=a;return a;}};
  const server=createMemoryServer(service);const client=new Client({name:'test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  const call=(name,args)=>client.callTool({name,arguments:args});
  try {
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(t=>t.name==='load_memory_context').annotations.readOnlyHint,true);
    assert.equal(tools.find(t=>t.name==='save_memory').annotations.readOnlyHint,false);
    assert.equal(tools.find(t=>t.name==='select_project').annotations.readOnlyHint,false);
    // Selection and permissions each have exactly one tool; the merged names are gone.
    assert.deepEqual(tools.map(t=>t.name).sort(),['confirm_memory','correct_memory','delete_memory','list_projects',
      'load_memory_context','memory_index','read_memory','retrieve_memory','save_memory','select_project','upsert_project']);
    assert.equal(tools.find(t=>t.name==='retrieve_memory').annotations.readOnlyHint,true);
    let result=await call('load_memory_context',{session_key:'one',event:'SessionStart'});
    const hook=JSON.parse(result.content[0].text);
    assert.equal(hook.hookSpecificOutput.hookEventName,'SessionStart');
    assert.ok(hook.hookSpecificOutput.additionalContext.includes('Read for fixture colour'),
      'session start carries the whole statement, so nothing needs fetching');
    assert.ok(!hook.hookSpecificOutput.additionalContext.includes('amber'),'and never the detail');
    assert.match(hook.hookSpecificOutput.additionalContext,/^<satchel>/);
    assert.equal(detailReads,0);assert.equal(writes,0);
    assert.equal(logged.at(-1).event,'SessionStart','what was injected is recorded');
    hintedProject=projectId;
    result=await call('load_memory_context',{session_key:'staged-session',event:'SessionStart'});
    // Session start carries only what applies regardless of what you do today.
    // A staged repository names the active project; it does not drag that
    // project's memories in, because loading them assumes you will touch it.
    assert.match(result.content[0].text,new RegExp(projectId),'the active project is stated');
    assert.doesNotMatch(result.content[0].text,/project-fixture/,'its memories are not preloaded');
    hintedProject=null;

    // Per prompt: retrieval, counts, and nothing at all when nothing matches.
    retrieval=[{id:summary.id,project_id:null,statement:'Read for fixture colour',
      band:'said',task_id:null,score:0.81,matched:4,in_scope:130}];
    result=await call('load_memory_context',{session_key:'one',event:'UserPromptSubmit',prompt:'fixture colour'});
    const perPrompt=JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext;
    assert.match(perPrompt,/1 shown · 4 matched · 130 in scope/,'counts separate "no rule" from "nothing scored"');
    assert.match(perPrompt,/Read for fixture colour/);
    assert.equal(searches.at(-1).query,'fixture colour','the prompt is the query and nothing else');
    assert.equal(logged.at(-1).event,'UserPromptSubmit');
    assert.deepEqual(logged.at(-1).memory_ids,[summary.id],'the log records exactly what was injected');

    // A placeholder the host did not substitute must never become the query.
    result=await call('load_memory_context',{session_key:'one',event:'UserPromptSubmit',
      prompt:'${prompt}',user_prompt:'fixture colour'});
    assert.equal(searches.at(-1).query,'fixture colour','the unsubstituted spelling is discarded');

    retrieval=[];
    result=await call('load_memory_context',{session_key:'one',event:'UserPromptSubmit',prompt:'unrelated'});
    assert.equal(JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext,'',
      'nothing relevant costs nothing');

    // An oversized session block is withheld, never truncated: a partial block
    // that looks complete is worse than an honest absence.
    oversized=true;
    result=await call('load_memory_context',{session_key:'budget',event:'SessionStart'});
    const overBudget=JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext;
    assert.match(overBudget,/NOT loaded/);
    assert.ok(!overBudget.includes('xxxx'),'no part of the oversized block leaks');
    oversized=false;
    result=await call('list_projects',{});
    const connection=JSON.parse(result.content[0].text);
    assert.equal(connection.can_write,true);
    assert.deepEqual(connection.projects,[{id:projectId,name:'Fixture',brief:''}]);
    assert.equal(connection.project_ids,undefined);
    result=await call('upsert_project',{request_id:crypto.randomUUID(),project_id:crypto.randomUUID(),
      name:'Created by agent',brief:'Fixture',repository_change:{kind:'link',repository:'NeerajG03/Satchel'}});
    assert.equal(JSON.parse(result.content[0].text).grant_required,true);
    assert.equal(projectWrites,1);
    assert.equal((await call('upsert_project',{request_id:crypto.randomUUID(),project_id:projectId,
      expected_revision:0,name:'Invalid revision'})).isError,true);
    assert.equal(projectWrites,1);
    // Selecting by repository returns the combined index without a follow-up memory_index call.
    result=await call('select_project',{session_key:'one',repository:'neerajg03/satchel'});
    assert.equal(activations,1);
    assert.match(result.content[0].text,/project-fixture/);
    assert.match(result.content[0].text,new RegExp(projectId));
    assert.equal(JSON.parse(result.content[0].text).complete,true);
    // Personal scope must not leak the previously selected project's memories.
    result=await call('select_project',{session_key:'one',project_id:null});
    assert.equal(JSON.parse(result.content[0].text).active_project,null);
    assert.match(result.content[0].text,/"name":"fixture"/);
    assert.doesNotMatch(result.content[0].text,/project-fixture/);
    assert.equal(activations,1);
    // Hosts that serialize unused optional arguments as null still reach personal scope.
    result=await call('select_project',{session_key:'one',project_id:null,repository:null});
    assert.ok(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).active_project,null);
    for(const ambiguous of [{session_key:'one'},{session_key:'one',project_id:projectId,repository:'neerajg03/satchel'}]) {
      const rejected=await call('select_project',ambiguous);
      assert.ok(rejected.isError);
      assert.match(rejected.content[0].text,/exactly one/);
    }
    assert.equal(activations,1);
    // A lifecycle selection stays budgeted and framed like the hook it stands in for.
    oversized=true;
    result=await call('select_project',{session_key:'one',event:'SessionStart',repository:'neerajg03/satchel'});
    assert.equal(activations,2);
    assert.match(result.content[0].text,/NOT loaded/);
    assert.doesNotMatch(result.content[0].text,/xxxx/);
    oversized=false;
    result=await call('select_project',{session_key:'one',event:'SessionStart',repository:'neerajg03/satchel'});
    // The block is now self-describing: the group headers carry the
    // instructions, so there is no fixed preamble to resend every time.
    assert.match(result.content[0].text,/<satchel>/);
    assert.match(result.content[0].text,/personal, confirmed, use freely/);
    // An unlinked repository must not read as a stale-name error.
    unlinked=true;
    result=await call('select_project',{session_key:'one',repository:'neerajg03/satchel'});
    assert.ok(result.isError);
    assert.match(result.content[0].text,/not linked to a project/);
    unlinked=false;
    // Personal scope without a personal grant is a denial, not a confident empty index.
    personal=false;
    result=await call('select_project',{session_key:'one',project_id:null});
    assert.ok(result.isError);
    assert.match(result.content[0].text,/Access denied/);
    personal=true;
    // read_memory now takes an id. A name was never a stable key, and with the
    // whole statement in the index it is only reached for the rare detail row.
    result=await call('read_memory',{project_id:null,id});
    assert.ok(result.content[0].text.includes('amber'));assert.equal(detailReads,1);
    await call('save_memory',{project_id:null,id:crypto.randomUUID(),statement:'A saved sentence.'});
    assert.equal(writes,1);
    const invalid=await call('save_memory',{project_id:null,statement:'missing id'});
    assert.ok(invalid.isError);assert.equal(writes,1);
    // An explicit save is confirmed by definition.
    assert.equal(service.lastSave?.band,'said');
    oversized=true;result=await call('load_memory_context',{session_key:'one',event:'SessionStart'});
    assert.ok(result.content[0].text.includes('NOT loaded'));
    revoked=true;result=await call('load_memory_context',{session_key:'one',event:'SessionStart'});
    assert.ok(result.content[0].text.includes('unavailable'));
    assert.ok((await call('read_memory',{project_id:null,id})).isError);
  }finally{await client.close();await server.close();}
});

test('OAuth token validation rejects wrong issuer/audience, expiry and missing grant claims',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('ES256');
  const token=(overrides={})=>new SignJWT({sub:crypto.randomUUID(),client_id:'fixture',satchel_grant_id:crypto.randomUUID(),...overrides})
    .setProtectedHeader({alg:'ES256'}).setIssuer(overrides.iss??SUPABASE_URL+'/auth/v1')
    .setAudience(overrides.aud??['authenticated',RESOURCE]).setExpirationTime(overrides.exp??'5m').sign(privateKey);
  assert.equal((await verifyAgentToken(await token(),publicKey)).client_id,'fixture');
  for(const bad of [{aud:'authenticated'},{iss:'https://other.invalid'},{exp:1},{satchel_grant_id:null},{client_id:null}])
    await assert.rejects(verifyAgentToken(await token(bad),publicKey));
});

test('MCP exposes revision-safe task operations without turning links into fetched content',async()=>{
  const projectId=crypto.randomUUID(),taskId=crypto.randomUUID();
  const calls=[];
  const service={
    status:async()=>({personal:false,task_personal:true,task_project_ids:[projectId],task_can_write:true,task_can_upload:false}),
    tasks:{
      list:async(project,statuses)=>({tasks:[{id:taskId,project_id:project,title:'Fixture',status:statuses?.[0]??'ready',revision:1}],complete:true}),
      read:async()=>({id:taskId,project_id:projectId,title:'Fixture',handoffs:[],updates:[],resources:[],update_resource_refs:[],events:[]}),
      create:async args=>{calls.push(['create',args]);return args;},
      update:async args=>{calls.push(['update',args]);return args;},
      transition:async args=>{calls.push(['transition',args]);return args;},
      handoff:async args=>{calls.push(['handoff',args]);return {task:{id:taskId,revision:2},handoff:{id:args.handoff_id}};},
      comment:async args=>{calls.push(['comment',args]);return {id:args.update_id,kind:'comment'};},
      progress:async args=>{calls.push(['progress',args]);return {task:{id:taskId,revision:2},update:{id:args.update_id,kind:'progress'}};},
      setParent:async args=>{calls.push(['parent',args]);return {task:{id:taskId,revision:2},parent_id:args.parent_id};},
      addDependency:async args=>{calls.push(['add-dependency',args]);return {task:{id:taskId,revision:2},depends_on_task_id:args.depends_on_task_id};},
      removeDependency:async args=>{calls.push(['remove-dependency',args]);return {task:{id:taskId,revision:2},removed_task_id:args.depends_on_task_id};},
      addResource:async args=>{calls.push(['resource',args]);return {task:{id:taskId,revision:2},resource:{external_url:args.url}};},
    },
  };
  const server=createMemoryServer(service);const client=new Client({name:'task-test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  const call=(name,args)=>client.callTool({name,arguments:args});
  try {
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(tool=>tool.name==='list_tasks').annotations.readOnlyHint,true);
    assert.equal(tools.find(tool=>tool.name==='record_task_update').annotations.idempotentHint,true);
    assert.equal(tools.find(tool=>tool.name==='edit_task').annotations.idempotentHint,true);
    assert.equal(tools.find(tool=>tool.name==='add_task_resource').annotations.openWorldHint,false);
    assert.deepEqual(tools.filter(tool=>tool.name.includes('task')).map(tool=>tool.name).sort(),[
      'add_task_resource','create_task','edit_task','list_tasks','read_task','record_task_update',
    ]);
    const listed=await call('list_tasks',{project_id:projectId,statuses:['ready']});
    assert.match(listed.content[0].text,/Fixture/);
    assert.match((await call('list_tasks',{project_id:null})).content[0].text,/Fixture/);
    await call('create_task',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,title:'Fixture'});
    await call('create_task',{request_id:crypto.randomUUID(),id:crypto.randomUUID(),project_id:null,title:'Personal fixture'});
    await call('edit_task',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,revision:1,
      change:{kind:'state',status:'in_progress'}});
    await call('record_task_update',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,
      entry:{kind:'handoff',entry_id:crypto.randomUUID(),revision:1,next_action:'Continue'}});
    await call('record_task_update',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,
      entry:{kind:'comment',entry_id:crypto.randomUUID(),body:'Useful context'}});
    await call('record_task_update',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,
      entry:{kind:'progress',entry_id:crypto.randomUUID(),revision:1,summary:'Implemented the next slice',next_action:'Verify it'}});
    const relatedId=crypto.randomUUID();
    await call('edit_task',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,revision:1,
      change:{kind:'parent',parent_id:relatedId}});
    await call('edit_task',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,revision:1,
      change:{kind:'add_dependency',depends_on_task_id:relatedId}});
    await call('edit_task',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,revision:1,
      change:{kind:'remove_dependency',depends_on_task_id:relatedId}});
    await call('add_task_resource',{request_id:crypto.randomUUID(),resource_id:crypto.randomUUID(),id:taskId,
      project_id:projectId,revision:1,label:'Docs',url:'https://example.com/doc'});
    assert.deepEqual(calls.map(entry=>entry[0]),['create','create','transition','handoff','comment','progress','parent','add-dependency','remove-dependency','resource']);
    const invalid=await call('add_task_resource',{request_id:crypto.randomUUID(),resource_id:crypto.randomUUID(),id:taskId,
      project_id:projectId,revision:1,label:'Unsafe',url:'http://example.com'});
    assert.equal(invalid.isError,true);
  }finally{await client.close();await server.close();}
});

test('task service requires an explicit personal-task grant for project_id null',async()=>{
  let calls=0;
  const db={rpc:()=>{calls++;return {single:()=>({abortSignal:async()=>({data:{id:'ok'},error:null})})};}};
  const args={project_id:null,request_id:crypto.randomUUID(),id:crypto.randomUUID(),title:'Personal',outcome:'',why:'',done_when:[],next_action:'',priority:'medium'};
  const denied=taskService(db,async()=>({task_personal:false,task_project_ids:[],task_can_write:true}));
  await assert.rejects(denied.create(args),{code:'42501'});
  assert.equal(calls,0);
  const allowed=taskService(db,async()=>({task_personal:true,task_project_ids:[],task_can_write:true}));
  assert.equal((await allowed.create(args)).id,'ok');
  assert.equal(calls,1);
});
