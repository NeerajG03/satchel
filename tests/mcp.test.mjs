import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {generateKeyPair,SignJWT} from 'jose';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {verifyAgentToken,RESOURCE,SUPABASE_URL} from '../server/http-handler.mjs';

test('MCP contracts separate index, detail, explicit writes and hook output',async()=>{
  const id=crypto.randomUUID(),topicId=crypto.randomUUID();let revoked=false,writes=0,topicWrites=0,oversized=false,detailReads=0,activations=0,unlinked=false,personal=true;
  const searches=[],logged=[];let retrieval=[];
  const summary={id,topic_id:null,name:'fixture',statement:'Read for fixture colour',band:'said',revision:1};
  const topicSummary={...summary,id:crypto.randomUUID(),topic_id:topicId,name:'topic-fixture'};
  const service={status:async()=>revoked?null:{label:'Test',personal,can_write:true,topic_ids:[topicId]},
    activeTopic:async()=>null,
    topics:async()=>[{id:topicId,name:'Fixture',brief:''}],
    upsertTopic:async a=>{topicWrites++;return {topic:{id:a.topic_id,name:a.name,brief:a.brief,revision:1},repositories:[],grant_required:true};},
    resolveRepository:async()=>[],
    selectTopic:async(_session,topic)=>({topic_id:topic}),
    selectRepository:async()=>{activations++;if(unlinked)throw {code:'P0002'};return {topic_id:topicId};},
    index:async topic=>({memories:oversized?[{...summary,statement:'x'.repeat(8000)}]:[topic?topicSummary:summary],complete:true}),
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
    assert.equal(tools.find(t=>t.name==='select_topic').annotations.readOnlyHint,false);
    assert.equal(tools.find(t=>t.name==='save_memory').inputSchema.properties.id,undefined);
    assert.equal(tools.find(t=>t.name==='correct_memory').inputSchema.properties.source,undefined);
    assert.equal(tools.find(t=>t.name==='upsert_topic').inputSchema.properties.request_id,undefined);
    // Selection and permissions each have exactly one tool; the merged names are gone.
    // load_memory_context is gone. Hooks are command scripts with their own
    // credential now, so they POST to /api/hook-index and /api/hook-capture
    // instead of asking the host to make a tool call. Its description was about
    // 244 tokens in every session's tool list, spent on a tool no model was
    // ever supposed to choose.
    assert.deepEqual(tools.map(t=>t.name).sort(),['confirm_memory','correct_memory','forget_memory','list_topics',
      'memory_index','read_memory','retrieve_memory','save_memory','select_topic','upsert_topic']);
    assert.equal(tools.find(t=>t.name==='retrieve_memory').annotations.readOnlyHint,true);
    // The lifecycle path, reached through select_topic's event argument.
    // That is the manual recovery route for a session whose hook could not run,
    // and it returns exactly what the hook endpoint would have injected.
    let result=await call('select_topic',{session_key:'one',event:'SessionStart',topic_id:null});
    const hook=JSON.parse(result.content[0].text);
    assert.equal(hook.hookSpecificOutput.hookEventName,'SessionStart');
    assert.ok(hook.hookSpecificOutput.additionalContext.includes('Read for fixture colour'),
      'session start carries the whole statement, so nothing needs fetching');
    assert.ok(!hook.hookSpecificOutput.additionalContext.includes('amber'),'and never the detail');
    assert.match(hook.hookSpecificOutput.additionalContext,/^<satchel>/);
    assert.equal(detailReads,0);assert.equal(writes,0);
    assert.equal(logged.at(-1).event,'SessionStart','what was injected is recorded');

    // Session start carries only what applies regardless of what you do today.
    // A selected topic is named; it does not drag that topic's memories in,
    // because loading them assumes you will touch it.
    result=await call('select_topic',{session_key:'staged-session',event:'SessionStart',topic_id:topicId});
    assert.match(result.content[0].text,new RegExp(topicId),'the active topic is stated');
    assert.doesNotMatch(result.content[0].text,/topic-fixture/,'its memories are not preloaded');

    // An oversized session block is withheld, never truncated: a partial block
    // that looks complete is worse than an honest absence.
    oversized=true;
    result=await call('select_topic',{session_key:'budget',event:'SessionStart',topic_id:null});
    const overBudget=JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext;
    assert.match(overBudget,/NOT loaded/);
    assert.ok(!overBudget.includes('xxxx'),'no part of the oversized block leaks');
    oversized=false;
    result=await call('list_topics',{});
    const connection=JSON.parse(result.content[0].text);
    assert.equal(connection.can_write,true);
    assert.deepEqual(connection.topics,[{id:topicId,name:'Fixture',brief:''}]);
    assert.equal(connection.topic_ids,undefined);
    result=await call('upsert_topic',{
      slug:'created-by-agent',name:'Created by agent',brief:'Fixture',
      repository_change:{kind:'link',repository:'NeerajG03/Satchel'}});
    assert.equal(JSON.parse(result.content[0].text).grant_required,true);
    assert.match(JSON.parse(result.content[0].text).topic.id,/^[0-9a-f-]{36}$/);
    assert.equal(topicWrites,1);
    assert.equal((await call('upsert_topic',{topic_id:topicId,
      slug:'invalid-revision',expected_revision:0,name:'Invalid revision'})).isError,true);
    // A slug is required, and a title-shaped one is rejected rather than
    // quietly slugified into something nobody would say.
    assert.equal((await call('upsert_topic',{name:'No slug'})).isError,true);
    assert.equal((await call('upsert_topic',{slug:'Not A Slug',name:'Bad slug'})).isError,true);
    assert.equal(topicWrites,1);
    // Selecting by repository returns the combined index without a follow-up memory_index call.
    result=await call('select_topic',{session_key:'one',repository:'neerajg03/satchel'});
    assert.equal(activations,1);
    assert.match(result.content[0].text,/topic-fixture/);
    assert.match(result.content[0].text,new RegExp(topicId));
    assert.equal(JSON.parse(result.content[0].text).complete,true);
    // Personal scope must not leak the previously selected topic's memories.
    result=await call('select_topic',{session_key:'one',topic_id:null});
    assert.equal(JSON.parse(result.content[0].text).active_topic,null);
    assert.match(result.content[0].text,/"name":"fixture"/);
    assert.doesNotMatch(result.content[0].text,/topic-fixture/);
    assert.equal(activations,1);
    // Hosts that serialize unused optional arguments as null still reach personal scope.
    result=await call('select_topic',{session_key:'one',topic_id:null,repository:null});
    assert.ok(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).active_topic,null);
    for(const ambiguous of [{session_key:'one'},{session_key:'one',topic_id:topicId,repository:'neerajg03/satchel'}]) {
      const rejected=await call('select_topic',ambiguous);
      assert.ok(rejected.isError);
      assert.match(rejected.content[0].text,/exactly one/);
    }
    assert.equal(activations,1);
    // A lifecycle selection stays budgeted and framed like the hook it stands in for.
    oversized=true;
    result=await call('select_topic',{session_key:'one',event:'SessionStart',repository:'neerajg03/satchel'});
    assert.equal(activations,2);
    assert.match(result.content[0].text,/NOT loaded/);
    assert.doesNotMatch(result.content[0].text,/xxxx/);
    oversized=false;
    result=await call('select_topic',{session_key:'one',event:'SessionStart',repository:'neerajg03/satchel'});
    // The block is now self-describing: the group headers carry the
    // instructions, so there is no fixed preamble to resend every time.
    assert.match(result.content[0].text,/<satchel>/);
    assert.match(result.content[0].text,/personal, confirmed, use freely/);
    // An unlinked repository must not read as a stale-name error.
    unlinked=true;
    result=await call('select_topic',{session_key:'one',repository:'neerajg03/satchel'});
    assert.ok(result.isError);
    assert.match(result.content[0].text,/not linked to a topic/);
    unlinked=false;
    // Personal scope without a personal grant is a denial, not a confident empty index.
    personal=false;
    result=await call('select_topic',{session_key:'one',topic_id:null});
    assert.ok(result.isError);
    assert.match(result.content[0].text,/no grant for personal memory/,'and it says which grant is missing');
    personal=true;
    // read_memory now takes an id. A name was never a stable key, and with the
    // whole statement in the index it is only reached for the rare detail row.
    result=await call('read_memory',{topic_id:null,id});
    assert.ok(result.content[0].text.includes('amber'));assert.equal(detailReads,1);
    await call('save_memory',{topic_id:null,statement:'A saved sentence.'});
    assert.equal(writes,1);
    assert.match(service.lastSave.id,/^[0-9a-f-]{36}$/);
    const invalid=await call('save_memory',{topic_id:null});
    assert.ok(invalid.isError);assert.equal(writes,1);
    // An explicit save is confirmed by definition.
    assert.equal(service.lastSave?.band,'said');
    // A rule the person asks to keep must be saved as one, or it loads as a fact.
    assert.equal(service.lastSave?.kind,'fact');
    await call('save_memory',{topic_id:null,statement:'Keep replies short.',kind:'preference'});
    assert.equal(service.lastSave?.kind,'preference');
    assert.ok((await call('save_memory',{topic_id:null,statement:'x',kind:'rule'})).isError);
    oversized=true;result=await call('select_topic',{session_key:'one',event:'SessionStart',topic_id:null});
    assert.ok(result.content[0].text.includes('NOT loaded'));
    // A revoked connection fails at the tool guard, before the lifecycle runs.
    revoked=true;result=await call('select_topic',{session_key:'one',event:'SessionStart',topic_id:null});
    assert.ok(result.isError);
    assert.match(result.content[0].text,/no longer authorized. Ask the user to reconnect/);
    assert.ok((await call('read_memory',{topic_id:null,id})).isError);
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

test('a refused tool call names the field or rule to change, never the whole row',async()=>{
  let refusal=null;
  const service={status:async()=>({personal:true,can_write:true,topic_ids:[]}),upsertTopic:async()=>{throw refusal;}};
  const server=createMemoryServer(service);const client=new Client({name:'test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});return {error:r.isError,text:r.content[0].text};};
  try {
    // Checked before any database call: the schema says what a slug is.
    let r=await call('upsert_topic',{slug:'Bad Slug!',name:'Fixture'});
    assert.ok(r.error);assert.match(r.text,/lowercase letters and digits.*at slug/);

    // A database refusal names the rule, says nothing landed, and never
    // repeats `details`, which for a check violation is the whole row.
    refusal={code:'23514',message:'new row for relation "topics" violates check constraint "topics_slug_check"',
      details:'Failing row contains (private brief)'};
    r=await call('upsert_topic',{slug:'ok-slug',name:'Fixture'});
    assert.match(JSON.parse(r.text).error,/^A topic slug is .*Nothing was written\.$/);
    assert.doesNotMatch(r.text,/private brief/);

    refusal={code:'PT409',message:'Topic changed or unavailable'};
    r=await call('upsert_topic',{slug:'ok-slug',name:'Fixture'});
    assert.match(JSON.parse(r.text).error,/Call list_topics and retry/);

    // A constraint nobody listed still names its field. The coverage test is
    // what keeps a real one from getting this far.
    refusal={code:'23514',message:'new row for relation "topics" violates check constraint "topics_mood_check"'};
    r=await call('upsert_topic',{slug:'ok-slug',name:'Fixture'});
    assert.match(JSON.parse(r.text).error,/^The mood value breaks the rule topics_mood_check/);
  }finally{await client.close();await server.close();}
});

test('a new topic with an unlink is refused before the write, saying why',async()=>{
  let writes=0;
  const service={status:async()=>({personal:true,topic_ids:[]}),upsertTopic:async()=>{writes++;return {};}};
  const server=createMemoryServer(service);const client=new Client({name:'test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  try {
    const r=await client.callTool({name:'upsert_topic',arguments:{
      slug:'new-thing',name:'New thing',repository_change:{kind:'unlink',repository:'acme/web'}}});
    assert.ok(r.isError);assert.match(r.content[0].text,/nothing to unlink/);assert.equal(writes,0);
    const bad=await client.callTool({name:'upsert_topic',arguments:{
      slug:'new-thing',name:'New thing',repository_change:{kind:'link',repository:'not a repo'}}});
    assert.match(bad.content[0].text,/lowercase owner\/repository/);
  }finally{await client.close();await server.close();}
});
