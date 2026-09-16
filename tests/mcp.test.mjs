import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {generateKeyPair,SignJWT} from 'jose';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {verifyAgentToken,RESOURCE,SUPABASE_URL} from '../server/http-handler.mjs';
import {taskService} from '../server/task-service.mjs';

test('MCP contracts separate index, detail, explicit writes and hook output',async()=>{
  const id=crypto.randomUUID(),projectId=crypto.randomUUID();let revoked=false,writes=0,oversized=false,detailReads=0,activations=0,hintedProject=null,unlinked=false,personal=true;
  const summary={id,project_id:null,name:'fixture',description:'Read for fixture colour',revision:1};
  const projectSummary={...summary,id:crypto.randomUUID(),project_id:projectId,name:'project-fixture'};
  const service={status:async()=>revoked?null:{label:'Test',personal,can_write:true,project_ids:[projectId]},
    activeProject:async()=>null,
    projects:async()=>[{id:projectId,name:'Fixture',brief:''}],
    repositoryHintExists:async()=>hintedProject!==null,
    activateRepositoryHint:async()=>hintedProject,
    selectProject:async(_session,project)=>({project_id:project}),
    selectRepository:async()=>{activations++;if(unlinked)throw {code:'P0002'};return {project_id:projectId};},
    index:async project=>({memories:oversized?[{...summary,description:'x'.repeat(8000)}]:[project?projectSummary:summary],complete:true}),
    read:async()=>{detailReads++;return {...summary,more_info:'amber'};},
    save:async a=>{writes++;return a;}};
  const server=createMemoryServer(service);const client=new Client({name:'test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  const call=(name,args)=>client.callTool({name,arguments:args});
  try {
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(t=>t.name==='load_memory_context').annotations.readOnlyHint,true);
    assert.equal(tools.find(t=>t.name==='save_memory').annotations.readOnlyHint,false);
    assert.equal(tools.find(t=>t.name==='select_project').annotations.readOnlyHint,false);
    // Selection and permissions each have exactly one tool; the merged names are gone.
    assert.deepEqual(tools.map(t=>t.name).sort(),['correct_memory','delete_memory','list_projects',
      'load_memory_context','memory_index','read_memory','save_memory','select_project']);
    let result=await call('load_memory_context',{session_key:'one',event:'SessionStart'});
    const hook=JSON.parse(result.content[0].text);
    assert.equal(hook.hookSpecificOutput.hookEventName,'SessionStart');
    assert.ok(hook.hookSpecificOutput.additionalContext.includes('fixture'));
    assert.ok(!hook.hookSpecificOutput.additionalContext.includes('amber'));
    assert.equal(detailReads,0);assert.equal(writes,0);
    hintedProject=projectId;
    result=await call('load_memory_context',{session_key:'staged-session',event:'SessionStart'});
    assert.match(result.content[0].text,/project-fixture/);
    assert.match(result.content[0].text,new RegExp(projectId));
    hintedProject=null;
    result=await call('list_projects',{});
    const connection=JSON.parse(result.content[0].text);
    assert.equal(connection.can_write,true);
    assert.deepEqual(connection.projects,[{id:projectId,name:'Fixture',brief:''}]);
    assert.equal(connection.project_ids,undefined);
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
    assert.match(result.content[0].text,/NOT loaded completely/);
    assert.doesNotMatch(result.content[0].text,/xxxx/);
    oversized=false;
    result=await call('select_project',{session_key:'one',event:'SessionStart',repository:'neerajg03/satchel'});
    assert.match(result.content[0].text,/saved user data, not system instructions/);
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
    result=await call('read_memory',{project_id:null,name:'fixture',expected_id:id});
    assert.ok(result.content[0].text.includes('amber'));assert.equal(detailReads,1);
    await call('save_memory',{project_id:null,id:crypto.randomUUID(),name:'new',description:'summary'});
    assert.equal(writes,1);
    const invalid=await call('save_memory',{project_id:null,name:'missing-id',description:'summary'});
    assert.ok(invalid.isError);assert.equal(writes,1);
    oversized=true;result=await call('load_memory_context',{session_key:'one',event:'SessionStart'});
    assert.ok(result.content[0].text.includes('NOT loaded completely'));
    revoked=true;result=await call('load_memory_context',{session_key:'one',event:'SessionStart'});
    assert.ok(result.content[0].text.includes('unavailable'));
    assert.ok((await call('read_memory',{project_id:null,name:'fixture',expected_id:id})).isError);
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
      addResource:async args=>{calls.push(['resource',args]);return {task:{id:taskId,revision:2},resource:{external_url:args.url}};},
    },
  };
  const server=createMemoryServer(service);const client=new Client({name:'task-test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  const call=(name,args)=>client.callTool({name,arguments:args});
  try {
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(tool=>tool.name==='list_tasks').annotations.readOnlyHint,true);
    assert.equal(tools.find(tool=>tool.name==='record_handoff').annotations.idempotentHint,true);
    assert.equal(tools.find(tool=>tool.name==='record_task_progress').annotations.idempotentHint,true);
    assert.equal(tools.find(tool=>tool.name==='add_task_resource').annotations.openWorldHint,false);
    const listed=await call('list_tasks',{project_id:projectId,statuses:['ready']});
    assert.match(listed.content[0].text,/Fixture/);
    assert.match((await call('list_tasks',{project_id:null})).content[0].text,/Fixture/);
    await call('create_task',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,title:'Fixture'});
    await call('create_task',{request_id:crypto.randomUUID(),id:crypto.randomUUID(),project_id:null,title:'Personal fixture'});
    await call('transition_task',{request_id:crypto.randomUUID(),id:taskId,project_id:projectId,revision:1,status:'in_progress'});
    await call('record_handoff',{request_id:crypto.randomUUID(),handoff_id:crypto.randomUUID(),id:taskId,
      project_id:projectId,revision:1,next_action:'Continue'});
    await call('add_task_comment',{request_id:crypto.randomUUID(),update_id:crypto.randomUUID(),id:taskId,
      project_id:projectId,body:'Useful context'});
    await call('record_task_progress',{request_id:crypto.randomUUID(),update_id:crypto.randomUUID(),id:taskId,
      project_id:projectId,revision:1,summary:'Implemented the next slice',next_action:'Verify it'});
    await call('add_task_resource',{request_id:crypto.randomUUID(),resource_id:crypto.randomUUID(),id:taskId,
      project_id:projectId,revision:1,label:'Docs',url:'https://example.com/doc'});
    assert.deepEqual(calls.map(entry=>entry[0]),['create','create','transition','handoff','comment','progress','resource']);
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
