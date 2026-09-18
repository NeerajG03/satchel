import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRepositoryHint,handleRepositoryHint} from '../server/repository-hint-handler.mjs';

const valid={session_key:'40000000-0000-4000-8000-000000000001',provider:'github',repository:'NeerajG03/Satchel'};

test('repository hint parser normalizes only bounded GitHub identities',()=>{
  assert.deepEqual(parseRepositoryHint(valid),{...valid,repository:'neerajg03/satchel'});
  for(const body of [null,{},'{',{
    ...valid,session_key:'short'},
    {...valid,provider:'gitlab'},
    {...valid,repository:'https://github.com/neerajg03/satchel'},
    {...valid,unexpected:'data'},
    {...valid,padding:'x'.repeat(1024)},
  ]) assert.throws(()=>parseRepositoryHint(body));
  assert.throws(()=>parseRepositoryHint(JSON.stringify({...valid,padding:'x'.repeat(1024)})));
});

test('repository hint endpoint returns no data and stages through the public RPC',async()=>{
  const calls=[];
  const makeClient=()=>({rpc:(name,args)=>({abortSignal:async()=>{calls.push({name,args});return {error:null};}})});
  const response={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(code,headers){this.code=code;this.responseHeaders=headers;},end(value){this.body=value;}};
  const previous=process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY='public-fixture';
  try {
    await handleRepositoryHint({method:'POST',headers:{},body:valid},response,makeClient);
  }finally {
    if(previous===undefined)delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    else process.env.VITE_SUPABASE_PUBLISHABLE_KEY=previous;
  }
  assert.equal(response.code,204);assert.equal(response.body,undefined);
  assert.deepEqual(calls,[{name:'stage_agent_repository_hint',args:{
    p_session_key:valid.session_key,p_provider:'github',p_repository:'neerajg03/satchel',
  }}]);
});

test('repository hint endpoint bounds requests before touching Supabase',async()=>{
  let calls=0;
  const makeClient=()=>({rpc:()=>{calls++;return {abortSignal:async()=>({error:null})};}});
  const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(code,headers){this.code=code;this.responseHeaders=headers;},end(value){this.body=value;}});
  const previous=process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY='public-fixture';
  try {
    let res=response();
    await handleRepositoryHint({method:'POST',headers:{'content-length':'1025'},body:valid},res,makeClient);
    assert.equal(res.code,413);
    res=response();
    await handleRepositoryHint({method:'POST',headers:{},body:{...valid,padding:'x'.repeat(1024)}},res,makeClient);
    assert.equal(res.code,400);
    res=response();
    await handleRepositoryHint({method:'GET',headers:{},body:null},res,makeClient);
    assert.equal(res.code,405);assert.equal(res.responseHeaders.Allow,'POST');
  }finally {
    if(previous===undefined)delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    else process.env.VITE_SUPABASE_PUBLISHABLE_KEY=previous;
  }
  assert.equal(calls,0);
});
