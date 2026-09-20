import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRouter, buildPrompt, validate, RouterError} from '../server/router.mjs';

const projects=[{slug:'cardinal-ledger',brief:'Go payments ledger'},{slug:'sourdough',brief:'Baking'}];
const tasks=[{slug:'fix-consent-layout',title:'Fix the corner leak',project:'cardinal-ledger'}];
const reply=memories=>async()=>({ok:true,status:200,json:async()=>({
  choices:[{message:{content:JSON.stringify({memories})}}]})});

test('the turn is separated from context, and only the turn is offered as a source',()=>{
  const prompt=buildPrompt({projects,tasks,
    context:[{role:'user',content:'earlier thing'},{role:'assistant',content:'my reply'}],
    turn:['the thing i just said']});
  assert.match(prompt,/never a source/);
  assert.ok(prompt.indexOf('earlier thing')<prompt.indexOf('<turn>'),'context comes before the turn');
  assert.match(prompt,/<turn>\nthe thing i just said\n<\/turn>/);
  assert.match(prompt,/cardinal-ledger/);
  assert.match(prompt,/fix-consent-layout/);
});

test('an assistant reply is clipped harder than a user message',()=>{
  const assistant=buildPrompt({context:[{role:'assistant',content:'x'.repeat(3000)}],turn:['hi']});
  const user=buildPrompt({context:[{role:'user',content:'x'.repeat(3000)}],turn:['hi']});
  // The longest run, not the first: the instructions themselves contain an x.
  const run=text=>Math.max(0,...(text.match(/x+/g)??[]).map(m=>m.length));
  assert.equal(run(assistant),800,'a reply is context, so 800 characters of it is enough');
  assert.equal(run(user),2000,'the user gets more room, because their words are what matter');
  assert.match(assistant,/<turn>\nhi\n<\/turn>/,'and the turn survives either way');
});

test('a statement the user never typed is dropped',()=>{
  const out=validate({memories:[
    {statement:'The user prefers tabs.',source:'i like tabs',project:null,task:null},
    {statement:'The user prefers spaces.',source:'i like spaces',project:null,task:null},
  ]},{turn:['honestly i like tabs in go'],projects,tasks});
  assert.equal(out.memories.length,1,'only the one with a real source survives');
  assert.equal(out.memories[0].statement,'The user prefers tabs.');
  assert.equal(out.dropped[0].why,'source is not in the turn');
});

test('an item with no source is dropped, however plausible',()=>{
  const out=validate({memories:[{statement:'Deploys happen on Fridays.',source:'',project:null,task:null}]},
    {turn:['deploys happen on fridays'],projects,tasks});
  assert.equal(out.memories.length,0);
  assert.equal(out.dropped[0].why,'no source');
});

test('an invented project falls back to personal rather than to a guess',()=>{
  const out=validate({memories:[{statement:'Keep it simple.',source:'keep it simple',
    project:'not-a-real-project',task:null}]},{turn:['keep it simple'],projects,tasks});
  assert.equal(out.memories[0].project,null,'personal loads everywhere, which is the harmless miss');
});

test('a task carries its own project, so a memory cannot land in the wrong scope',()=>{
  const out=validate({memories:[{statement:'The paper panel leaks at the corner.',
    source:'the paper panel leaks at the corner',project:'sourdough',task:'fix-consent-layout'}]},
    {turn:['the paper panel leaks at the corner'],projects,tasks});
  assert.equal(out.memories[0].task,'fix-consent-layout');
  assert.equal(out.memories[0].project,'cardinal-ledger','the task overrides a disagreeing project');
});

test('an unknown task is dropped to null rather than invented',()=>{
  const out=validate({memories:[{statement:'A thing.',source:'a thing',project:'sourdough',task:'no-such-task'}]},
    {turn:['a thing'],projects,tasks});
  assert.equal(out.memories[0].task,null);
  assert.equal(out.memories[0].project,'sourdough','a valid project still stands');
});

test('an oversized statement is refused at the boundary',()=>{
  const out=validate({memories:[{statement:'x'.repeat(501),source:'hello',project:null,task:null}]},
    {turn:['hello'],projects,tasks});
  assert.equal(out.memories.length,0);
});

test('an empty list is a real answer and not an error',async()=>{
  const router=createRouter({apiKey:'x',fetchImpl:reply([])});
  const out=await router.route({projects,tasks,context:[],turn:['ok keep going']});
  assert.deepEqual(out.memories,[]);
  assert.equal(out.dropped.length,0);
});

test('the prompt and the raw reply come back, because a capture has to be explainable',async()=>{
  const router=createRouter({apiKey:'x',fetchImpl:reply([
    {statement:'No em dashes anywhere.',source:'no em dashes',project:null,task:null}])});
  const out=await router.route({projects,tasks,context:[],turn:['please no em dashes anywhere']});
  assert.match(out.prompt,/<turn>/);
  assert.match(out.raw,/No em dashes anywhere/);
});

test('content that is not JSON fails loudly rather than capturing nothing quietly',async()=>{
  const router=createRouter({apiKey:'x',fetchImpl:async()=>({ok:true,status:200,
    json:async()=>({choices:[{message:{content:'I think you want: no em dashes'}}]})})});
  await assert.rejects(router.route({projects,tasks,context:[],turn:['x']}),/not JSON/);
});

test('a rate limit is retried once and then surfaces',async()=>{
  let calls=0;
  const router=createRouter({apiKey:'x',fetchImpl:async()=>{
    calls++;
    return {ok:false,status:429,headers:{get:()=>String(Date.now()+10)},json:async()=>({})};
  }});
  await assert.rejects(router.route({projects,tasks,context:[],turn:['x']}),/429/);
  assert.equal(calls,2,'one retry, not a loop');
});

test('a missing key is a configuration error, not a silent no-op',async()=>{
  const router=createRouter({apiKey:undefined,fetchImpl:reply([])});
  await assert.rejects(router.route({projects,tasks,context:[],turn:['x']}),RouterError);
});
