import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {generateKeyPair,SignJWT} from 'jose';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {verifyAgentToken,RESOURCE,SUPABASE_URL} from '../server/http-handler.mjs';

test('MCP contracts separate index, detail, explicit writes and hook output',async()=>{
  const id=crypto.randomUUID(),projectId=crypto.randomUUID();let revoked=false,writes=0,oversized=false,detailReads=0,activations=0;
  const summary={id,project_id:null,name:'fixture',description:'Read for fixture colour',revision:1};
  const projectSummary={...summary,id:crypto.randomUUID(),project_id:projectId,name:'project-fixture'};
  const service={status:async()=>revoked?null:{personal:true},activeProject:async()=>null,
    selectRepository:async()=>{activations++;return {project_id:projectId};},
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
    assert.equal(tools.find(t=>t.name==='activate_repository').annotations.readOnlyHint,false);
    let result=await call('load_memory_context',{session_key:'one',event:'UserPromptSubmit'});
    const hook=JSON.parse(result.content[0].text);
    assert.equal(hook.hookSpecificOutput.hookEventName,'UserPromptSubmit');
    assert.ok(hook.hookSpecificOutput.additionalContext.includes('fixture'));
    assert.ok(!hook.hookSpecificOutput.additionalContext.includes('amber'));
    assert.equal(detailReads,0);assert.equal(writes,0);
    result=await call('activate_repository',{session_key:'one',event:'SessionStart',provider:'github',repository:'neerajg03/satchel'});
    assert.equal(activations,1);
    assert.match(result.content[0].text,/project-fixture/);
    assert.match(result.content[0].text,new RegExp(projectId));
    result=await call('read_memory',{project_id:null,name:'fixture',expected_id:id});
    assert.ok(result.content[0].text.includes('amber'));assert.equal(detailReads,1);
    await call('save_memory',{project_id:null,id:crypto.randomUUID(),name:'new',description:'summary'});
    assert.equal(writes,1);
    const invalid=await call('save_memory',{project_id:null,name:'missing-id',description:'summary'});
    assert.ok(invalid.isError);assert.equal(writes,1);
    oversized=true;result=await call('load_memory_context',{session_key:'one',event:'UserPromptSubmit'});
    assert.ok(result.content[0].text.includes('NOT loaded completely'));
    revoked=true;result=await call('load_memory_context',{session_key:'one',event:'UserPromptSubmit'});
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
