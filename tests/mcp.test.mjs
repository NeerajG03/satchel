import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {generateKeyPair,SignJWT} from 'jose';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {verifyAgentToken,RESOURCE,SUPABASE_URL} from '../server/http-handler.mjs';
import {taskService} from '../server/task-service.mjs';

test('MCP contracts separate index, detail, explicit writes and hook output',async()=>{
  const id=crypto.randomUUID(),projectId=crypto.randomUUID();let revoked=false,writes=0,projectWrites=0,oversized=false,detailReads=0,activations=0,unlinked=false,personal=true;
  const searches=[],logged=[];let retrieval=[];
  const summary={id,project_id:null,name:'fixture',statement:'Read for fixture colour',band:'said',task_id:null,revision:1};
  const projectSummary={...summary,id:crypto.randomUUID(),project_id:projectId,name:'project-fixture'};
  const service={status:async()=>revoked?null:{label:'Test',personal,can_write:true,project_ids:[projectId]},
    activeProject:async()=>null,
    projects:async()=>[{id:projectId,name:'Fixture',brief:''}],
    upsertProject:async a=>{projectWrites++;return {project:{id:a.project_id,name:a.name,brief:a.brief,revision:1},repositories:[],grant_required:true};},
    resolveRepository:async()=>[],
    selectProject:async(_session,project)=>({project_id:project}),
    selectRepository:async()=>{activations++;if(unlinked)throw {code:'P0002'};return {project_id:projectId};},
    index:async project=>({memories:oversized?[{...summary,statement:'x'.repeat(8000)}]:[project?projectSummary:summary],complete:true}),
    read:async()=>{detailReads++;return {...summary,more_info:'amber'};},
    settings:async()=>({gate:0.62,scope_boost:1.1,session_budget_tokens:oversized?1000:15000}),
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
    assert.equal(tools.find(t=>t.name==='save_memory').annotations.readOnlyHint,false);
    assert.equal(tools.find(t=>t.name==='select_project').annotations.readOnlyHint,false);
    assert.equal(tools.find(t=>t.name==='save_memory').inputSchema.properties.id,undefined);
    assert.equal(tools.find(t=>t.name==='correct_memory').inputSchema.properties.source,undefined);
    assert.equal(tools.find(t=>t.name==='upsert_project').inputSchema.properties.request_id,undefined);
    // Selection and permissions each have exactly one tool; the merged names are gone.
    // load_memory_context is gone. Hooks are command scripts with their own
    // credential now, so they POST to /api/hook-index and /api/hook-capture
    // instead of asking the host to make a tool call. Its description was about
    // 244 tokens in every session's tool list, spent on a tool no model was
    // ever supposed to choose.
    assert.deepEqual(tools.map(t=>t.name).sort(),['confirm_memory','correct_memory','forget_memory','list_projects',
      'memory_index','read_memory','retrieve_memory','save_memory','select_project','upsert_project']);
    assert.equal(tools.find(t=>t.name==='retrieve_memory').annotations.readOnlyHint,true);
    // The lifecycle path, reached through select_project's event argument.
    // That is the manual recovery route for a session whose hook could not run,
    // and it returns exactly what the hook endpoint would have injected.
    let result=await call('select_project',{session_key:'one',event:'SessionStart',project_id:null});
    const hook=JSON.parse(result.content[0].text);
    assert.equal(hook.hookSpecificOutput.hookEventName,'SessionStart');
    assert.ok(hook.hookSpecificOutput.additionalContext.includes('Read for fixture colour'),
      'session start carries the whole statement, so nothing needs fetching');
    assert.ok(!hook.hookSpecificOutput.additionalContext.includes('amber'),'and never the detail');
    assert.match(hook.hookSpecificOutput.additionalContext,/^<satchel>/);
    assert.equal(detailReads,0);assert.equal(writes,0);
    assert.equal(logged.at(-1).event,'SessionStart','what was injected is recorded');

    // Session start carries only what applies regardless of what you do today.
    // A selected project is named; it does not drag that project's memories in,
    // because loading them assumes you will touch it.
    result=await call('select_project',{session_key:'staged-session',event:'SessionStart',project_id:projectId});
    assert.match(result.content[0].text,new RegExp(projectId),'the active project is stated');
    assert.doesNotMatch(result.content[0].text,/project-fixture/,'its memories are not preloaded');

    // An oversized session block is withheld, never truncated: a partial block
    // that looks complete is worse than an honest absence.
    oversized=true;
    result=await call('select_project',{session_key:'budget',event:'SessionStart',project_id:null});
    const overBudget=JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext;
    assert.match(overBudget,/NOT loaded/);
    assert.ok(!overBudget.includes('xxxx'),'no part of the oversized block leaks');
    oversized=false;
    result=await call('list_projects',{});
    const connection=JSON.parse(result.content[0].text);
    assert.equal(connection.can_write,true);
    assert.deepEqual(connection.projects,[{id:projectId,name:'Fixture',brief:''}]);
    assert.equal(connection.project_ids,undefined);
    result=await call('upsert_project',{
      slug:'created-by-agent',name:'Created by agent',brief:'Fixture',
      repository_change:{kind:'link',repository:'NeerajG03/Satchel'}});
    assert.equal(JSON.parse(result.content[0].text).grant_required,true);
    assert.match(JSON.parse(result.content[0].text).project.id,/^[0-9a-f-]{36}$/);
    assert.equal(projectWrites,1);
    assert.equal((await call('upsert_project',{project_id:projectId,
      slug:'invalid-revision',expected_revision:0,name:'Invalid revision'})).isError,true);
    // A slug is required, and a title-shaped one is rejected rather than
    // quietly slugified into something nobody would say.
    assert.equal((await call('upsert_project',{name:'No slug'})).isError,true);
    assert.equal((await call('upsert_project',{slug:'Not A Slug',name:'Bad slug'})).isError,true);
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
    assert.match(result.content[0].text,/no grant for personal memory/,'and it says which grant is missing');
    personal=true;
    // read_memory now takes an id. A name was never a stable key, and with the
    // whole statement in the index it is only reached for the rare detail row.
    result=await call('read_memory',{project_id:null,id});
    assert.ok(result.content[0].text.includes('amber'));assert.equal(detailReads,1);
    await call('save_memory',{project_id:null,statement:'A saved sentence.'});
    assert.equal(writes,1);
    assert.match(service.lastSave.id,/^[0-9a-f-]{36}$/);
    const invalid=await call('save_memory',{project_id:null});
    assert.ok(invalid.isError);assert.equal(writes,1);
    // An explicit save is confirmed by definition.
    assert.equal(service.lastSave?.band,'said');
    oversized=true;result=await call('select_project',{session_key:'one',event:'SessionStart',project_id:null});
    assert.ok(result.content[0].text.includes('NOT loaded'));
    // A revoked connection fails at the tool guard, before the lifecycle runs.
    revoked=true;result=await call('select_project',{session_key:'one',event:'SessionStart',project_id:null});
    assert.ok(result.isError);
    assert.match(result.content[0].text,/no longer authorized. Ask the user to reconnect/);
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
    assert.equal(tools.find(tool=>tool.name==='record_task_update').annotations.idempotentHint,false);
    assert.equal(tools.find(tool=>tool.name==='edit_task').annotations.idempotentHint,false);
    assert.equal(tools.find(tool=>tool.name==='add_task_resource').annotations.openWorldHint,false);
    for(const name of ['create_task','edit_task','record_task_update','add_task_resource'])
      assert.equal(tools.find(tool=>tool.name===name).inputSchema.properties.request_id,undefined);
    assert.equal(tools.find(tool=>tool.name==='create_task').inputSchema.properties.id,undefined);
    assert.equal(tools.find(tool=>tool.name==='add_task_resource').inputSchema.properties.resource_id,undefined);
    assert.deepEqual(tools.filter(tool=>tool.name.includes('task')).map(tool=>tool.name).sort(),[
      'add_task_resource','create_task','edit_task','list_tasks','read_task','record_task_update',
    ]);
    const listed=await call('list_tasks',{project_id:projectId,statuses:['ready']});
    assert.match(listed.content[0].text,/Fixture/);
    assert.match((await call('list_tasks',{project_id:null})).content[0].text,/Fixture/);
    await call('create_task',{slug:'fixture-task',project_id:projectId,title:'Fixture'});
    await call('create_task',{slug:'personal-fixture',project_id:null,title:'Personal fixture'});
    assert.equal((await call('create_task',{
      project_id:projectId,title:'No slug'})).isError,true,'a task cannot be created without a slug');
    await call('edit_task',{id:taskId,project_id:projectId,revision:1,
      change:{kind:'state',status:'in_progress'}});
    await call('record_task_update',{id:taskId,project_id:projectId,
      entry:{kind:'handoff',revision:1,next_action:'Continue'}});
    await call('record_task_update',{id:taskId,project_id:projectId,
      entry:{kind:'comment',body:'Useful context'}});
    await call('record_task_update',{id:taskId,project_id:projectId,
      entry:{kind:'progress',revision:1,summary:'Implemented the next slice',next_action:'Verify it'}});
    const relatedId=crypto.randomUUID();
    await call('edit_task',{id:taskId,project_id:projectId,revision:1,
      change:{kind:'parent',parent_id:relatedId}});
    await call('edit_task',{id:taskId,project_id:projectId,revision:1,
      change:{kind:'add_dependency',depends_on_task_id:relatedId}});
    await call('edit_task',{id:taskId,project_id:projectId,revision:1,
      change:{kind:'remove_dependency',depends_on_task_id:relatedId}});
    await call('add_task_resource',{id:taskId,
      project_id:projectId,revision:1,label:'Docs',url:'https://example.com/doc'});
    assert.deepEqual(calls.map(entry=>entry[0]),['create','create','transition','handoff','comment','progress','parent','add-dependency','remove-dependency','resource']);
    for(const [,args] of calls)
      assert.match(args.request_id,/^[0-9a-f-]{36}$/);
    assert.match(calls[0][1].id,/^[0-9a-f-]{36}$/);
    assert.match(calls.find(([kind])=>kind==='comment')[1].update_id,/^[0-9a-f-]{36}$/);
    assert.match(calls.find(([kind])=>kind==='resource')[1].resource_id,/^[0-9a-f-]{36}$/);
    const invalid=await call('add_task_resource',{id:taskId,
      project_id:projectId,revision:1,label:'Unsafe',url:'http://example.com'});
    assert.equal(invalid.isError,true);
  }finally{await client.close();await server.close();}
});

test('task service requires an explicit personal-task grant for project_id null',async()=>{
  let calls=0;
  const db={rpc:()=>{calls++;return {single:()=>({abortSignal:async()=>({data:{id:'ok'},error:null})})};}};
  const args={project_id:null,request_id:crypto.randomUUID(),id:crypto.randomUUID(),title:'Personal',outcome:'',why:'',done_when:[],next_action:'',priority:'medium'};
  const denied=taskService(db,async()=>({task_personal:false,task_project_ids:[],task_can_write:true}));
  await assert.rejects(denied.create(args),{code:'42501',message:'Personal tasks unavailable'});
  assert.equal(calls,0);
  const allowed=taskService(db,async()=>({task_personal:true,task_project_ids:[],task_can_write:true}));
  assert.equal((await allowed.create(args)).id,'ok');
  assert.equal(calls,1);
});

test('a refused tool call names the field or rule to change, never the whole row',async()=>{
  let refusal=null;
  const service={status:async()=>({personal:true,task_personal:true,task_can_write:true,project_ids:[]}),
    tasks:{create:async()=>{throw refusal;},transition:async()=>({}),setParent:async()=>({}),addDependency:async()=>({})}};
  const server=createMemoryServer(service);const client=new Client({name:'test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});return {error:r.isError,text:r.content[0].text};};
  const ids=()=>({id:crypto.randomUUID()});
  try {
    // Checked before any database call: the schema says what a slug is.
    let r=await call('create_task',{...ids(),slug:'Bad Slug!',project_id:null,title:'Fixture'});
    assert.ok(r.error);assert.match(r.text,/lowercase letters and digits.*at slug/);

    // Cross-field rules the database also holds are caught first.
    r=await call('edit_task',{...ids(),project_id:null,revision:1,change:{kind:'state',status:'blocked'}});
    assert.ok(r.error);assert.match(r.text,/blocked_reason/);
    const same=ids();
    r=await call('edit_task',{...same,project_id:null,revision:1,change:{kind:'add_dependency',depends_on_task_id:same.id}});
    assert.match(r.text,/cannot depend on itself/);
    r=await call('edit_task',{...same,project_id:null,revision:1,change:{kind:'parent',parent_id:same.id}});
    assert.match(r.text,/cannot be its own parent/);
    const resource=crypto.randomUUID();
    r=await call('record_task_update',{...ids(),project_id:null,
      entry:{kind:'comment',body:'x',resource_ids:[resource,resource]}});
    assert.match(r.text,/same id twice/);

    // A database refusal names the rule, says nothing landed, and never
    // repeats `details`, which for a check violation is the whole row.
    refusal={code:'23514',message:'new row for relation "tasks" violates check constraint "tasks_slug_check"',
      details:'Failing row contains (private title)'};
    r=await call('create_task',{...ids(),slug:'ok-slug',project_id:null,title:'Fixture'});
    assert.match(JSON.parse(r.text).error,/^A task slug is .*Nothing was written\.$/);
    assert.doesNotMatch(r.text,/private title/);
    refusal={code:'23514',message:'Blocked tasks require a reason'};
    r=await call('create_task',{...ids(),slug:'ok-slug',project_id:null,title:'Fixture'});
    assert.equal(JSON.parse(r.text).error,'A blocked status needs a blocked_reason saying what it is waiting on. Nothing was written.');
    // A progress list the table would refuse for its joined length.
    r=await call('record_task_update',{...ids(),project_id:null,entry:{kind:'progress',
      revision:1,summary:'s',completed:Array.from({length:25},()=>'x'.repeat(1000))}});
    assert.ok(r.error);assert.match(r.text,/20000 characters in total.*at entry\.completed/);
    r=await call('add_task_resource',{...ids(),project_id:null,revision:1,label:'Doc',url:'http://example.com'});
    assert.match(r.text,/https URL/);

    // The two conflicts that shared one line now say which one it was.
    refusal={code:'PT409',message:'Task request conflict'};
    r=await call('create_task',{...ids(),slug:'ok-slug',project_id:null,title:'Fixture'});
    assert.match(JSON.parse(r.text).error,/Check the task list before trying again/);
    refusal={code:'PT409',message:'Task changed or unavailable'};
    r=await call('create_task',{...ids(),slug:'ok-slug',project_id:null,title:'Fixture'});
    assert.match(JSON.parse(r.text).error,/read_task and retry with the current revision/);

    refusal={code:'23514',message:'new row for relation "task_updates" violates check constraint "task_updates_body_check"'};
    r=await call('create_task',{...ids(),slug:'ok-slug',project_id:null,title:'Fixture'});
    assert.equal(JSON.parse(r.text).error,'A comment body is 1 to 4000 characters. Nothing was written.');
    // A constraint nobody listed still names its field. The coverage test is
    // what keeps a real one from getting this far.
    refusal={code:'23514',message:'new row for relation "task_updates" violates check constraint "task_updates_mood_check"'};
    r=await call('create_task',{...ids(),slug:'ok-slug',project_id:null,title:'Fixture'});
    assert.match(JSON.parse(r.text).error,/^The mood value breaks the rule task_updates_mood_check/);
  }finally{await client.close();await server.close();}
});

test('a new project with an unlink is refused before the write, saying why',async()=>{
  let writes=0;
  const service={status:async()=>({personal:true,project_ids:[]}),upsertProject:async()=>{writes++;return {};}};
  const server=createMemoryServer(service);const client=new Client({name:'test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  try {
    const r=await client.callTool({name:'upsert_project',arguments:{
      slug:'new-thing',name:'New thing',repository_change:{kind:'unlink',repository:'acme/web'}}});
    assert.ok(r.isError);assert.match(r.content[0].text,/nothing to unlink/);assert.equal(writes,0);
    const bad=await client.callTool({name:'upsert_project',arguments:{
      slug:'new-thing',name:'New thing',repository_change:{kind:'link',repository:'not a repo'}}});
    assert.match(bad.content[0].text,/lowercase owner\/repository/);
  }finally{await client.close();await server.close();}
});
