import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRouter, buildPrompt, validate, RouterError} from '../server/router.mjs';

const projects=[{slug:'cardinal-ledger',brief:'Go payments ledger'},{slug:'sourdough',brief:'Baking'}];
// Google's native generateContent shape, read off a real call. The router asks
// through the native provider now so the schema is enforced by the provider
// rather than requested in prose and recovered from a code fence.
const json=(body,status=200)=>new Response(JSON.stringify(body),
  {status,headers:{'content-type':'application/json'}});
const content=text=>json({candidates:[{content:{parts:[{text}]},finishReason:'STOP'}],
  usageMetadata:{promptTokenCount:700,candidatesTokenCount:40,totalTokenCount:740}});
const reply=memories=>async()=>content(JSON.stringify({memories}));

test('the rules and the conversation are separate messages',()=>{
  // They were one user message: the instructions, the lists, and the user's own
  // words separated from the rules only by a <turn> tag. The stable half is
  // identical on every call, so splitting it makes the boundary between "rules"
  // and "text a person typed" structural rather than a tag.
  const {system,prompt}=buildPrompt({projects,turn:['the thing i just said']});
  assert.match(system,/decide whether the user said anything worth remembering/);
  assert.doesNotMatch(system,/the thing i just said/,'nothing the user typed belongs in the rules');
  assert.doesNotMatch(prompt,/An empty list is a normal and correct answer/,
    'and the rules are not repeated in the half that changes every call');
});

test('the turn is separated from context, and only the turn is offered as a source',()=>{
  const {prompt}=buildPrompt({projects,
    context:[{role:'user',content:'earlier thing'},{role:'assistant',content:'my reply'}],
    turn:['the thing i just said']});
  assert.match(prompt,/never a source/);
  assert.ok(prompt.indexOf('earlier thing')<prompt.indexOf('<turn>'),'context comes before the turn');
  assert.match(prompt,/<turn>\nthe thing i just said\n<\/turn>/);
  assert.match(prompt,/cardinal-ledger/);
});

test('no list of open work is put in front of a model deciding what is durable',()=>{
  // The task list was there so the model could pick a task slug per item. A
  // memory has one scope now and it is a project or personal, so there is
  // nothing to pick, and a list of things in progress pulls the model towards
  // exactly the class of claim it is supposed to refuse.
  const {prompt}=buildPrompt({projects,tasks:[{slug:'fix-consent-layout',title:'Fix the corner leak'}],
    turn:['the paper panel leaks at the corner']});
  assert.doesNotMatch(prompt,/open tasks/);
  assert.doesNotMatch(prompt,/fix-consent-layout/);
});

test('the scope the conversation is in is stated, not left to be inferred',()=>{
  // The whole reason a memory about a project's own deployment key was filed
  // under personal. The model had every project in a flat list and nothing
  // saying which one the conversation was in, so it inferred the scope from the
  // words, and the words did not say.
  const {prompt}=buildPrompt({codebase:'neerajg03/satchel',
    project:{slug:'satchel',brief:'The memory and task companion'},
    projects:[...projects,{slug:'satchel',brief:'The memory and task companion'}],
    turn:['i also added a paid key to vercel']});
  assert.match(prompt,/working on\n  codebase  neerajg03\/satchel\n  project   satchel/);
  // Named once, under "working on", and not repeated in the list of others.
  const others=prompt.slice(prompt.indexOf('other projects'),prompt.indexOf('classify only'));
  assert.doesNotMatch(others,/satchel/,'the active project is not also one of the others');
  assert.match(others,/cardinal-ledger/);
});

test('with no project selected the prompt says so rather than staying silent',()=>{
  const {prompt}=buildPrompt({codebase:'neerajg03/satchel',project:null,turn:['hi']});
  assert.match(prompt,/none selected, so use null unless the user names a project/);
});

test('what was already saved this session is listed, so it is not saved twice',()=>{
  const {prompt}=buildPrompt({saved:['A paid key was added to Vercel instead of the free one.'],
    turn:['and the limits are better now']});
  assert.match(prompt,/already saved in this session, do not save any of these again/);
  assert.match(prompt,/A paid key was added to Vercel/);
});

test('an assistant reply is clipped harder than a user message',()=>{
  const assistant=buildPrompt({context:[{role:'assistant',content:'x'.repeat(3000)}],turn:['hi']}).prompt;
  const user=buildPrompt({context:[{role:'user',content:'x'.repeat(3000)}],turn:['hi']}).prompt;
  const run=text=>Math.max(0,...(text.match(/x+/g)??[]).map(m=>m.length));
  assert.equal(run(assistant),800,'a reply is context, so 800 characters of it is enough');
  assert.equal(run(user),2000,'the user gets more room, because their words are what matter');
  assert.match(assistant,/<turn>\nhi\n<\/turn>/,'and the turn survives either way');
});

test('the active project is nameable, and a repeat is dropped',()=>{
  // The active project is not in `projects`, so a model doing exactly what the
  // instructions ask would have had every item knocked back to personal here,
  // which is the bug being fixed wearing a different hat.
  const out=validate({memories:[
    {statement:'A paid key was added to Vercel.',source:'i added a paid key to vercel',
      project:'satchel'},
    {statement:'a paid key was added to vercel',source:'i added a paid key to vercel',
      project:'satchel'},
  ]},{turn:['i added a paid key to vercel'],project:{slug:'satchel'},projects,
    saved:['A paid key was added to Vercel.']});
  assert.equal(out.memories.length,0,'both are already saved, in the same words and in different case');
  assert.deepEqual(out.dropped.map(d=>d.why),['already saved this session','already saved this session']);

  const kept=validate({memories:[
    {statement:'A paid key was added to Vercel.',source:'i added a paid key to vercel',
      project:'satchel'},
  ]},{turn:['i added a paid key to vercel'],project:{slug:'satchel'},projects});
  assert.equal(kept.memories[0].project,'satchel','the active project must survive validation');
});

test('a statement the user never typed is dropped',()=>{
  const out=validate({memories:[
    {statement:'The user prefers tabs.',source:'i like tabs',project:null},
    {statement:'The user prefers spaces.',source:'i like spaces',project:null},
  ]},{turn:['honestly i like tabs in go'],projects});
  assert.equal(out.memories.length,1,'only the one with a real source survives');
  assert.equal(out.memories[0].statement,'The user prefers tabs.');
  assert.equal(out.dropped[0].why,'source is not in the turn');
});

test('an item with no source is dropped, however plausible',()=>{
  const out=validate({memories:[{statement:'Deploys happen on Fridays.',source:'',project:null}]},
    {turn:['deploys happen on fridays'],projects});
  assert.equal(out.memories.length,0);
  assert.equal(out.dropped[0].why,'no source');
});

test('an invented project falls back to personal rather than to a guess',()=>{
  const out=validate({memories:[{statement:'Keep it simple.',source:'keep it simple',
    project:'not-a-real-project'}]},{turn:['keep it simple'],projects});
  assert.equal(out.memories[0].project,null,'personal loads everywhere, which is the harmless miss');
});

test('a memory keeps one scope, and nothing can move it after the fact',()=>{
  // This used to be `project: task ? taskProject : project`, so naming a task
  // in another project silently relocated the memory. A model that guessed the
  // task wrong moved a rule into a project the user never mentioned, and
  // nothing downstream could tell.
  const out=validate({memories:[{statement:'The paper panel leaks at the corner.',
    source:'the paper panel leaks at the corner',project:'sourdough',task:'fix-consent-layout'}]},
    {turn:['the paper panel leaks at the corner'],projects});
  assert.equal(out.memories[0].project,'sourdough','the scope is the one named and nothing else');
  assert.equal('task' in out.memories[0],false,'and there is no task on it at all');
});

test('an oversized statement is refused at the boundary',()=>{
  const out=validate({memories:[{statement:'x'.repeat(501),source:'hello',project:null}]},
    {turn:['hello'],projects});
  assert.equal(out.memories.length,0);
});

test('an empty list is a real answer and not an error',async()=>{
  const router=createRouter({apiKey:'x',fetchImpl:reply([])});
  const out=await router.route({projects,context:[],turn:['ok keep going']});
  assert.deepEqual(out.memories,[]);
  assert.equal(out.dropped.length,0);
});

test('the prompt and the raw reply come back, because a capture has to be explainable',async()=>{
  const router=createRouter({apiKey:'x',fetchImpl:reply([
    {statement:'No em dashes anywhere.',source:'no em dashes',project:null}])});
  const out=await router.route({projects,context:[],turn:['please no em dashes anywhere']});
  assert.match(out.prompt,/<turn>/);
  assert.match(out.raw,/No em dashes anywhere/);
});

test('content that is not the agreed shape fails loudly rather than capturing nothing quietly',async()=>{
  // This used to need a fence-stripping parser and a prose fallback prompt,
  // because a model told to return JSON in words sometimes wraps it. The
  // provider enforces the schema now, so prose is a failure rather than
  // something to recover from, and it still fails loudly: a capture that
  // quietly does nothing is indistinguishable from one with nothing to keep.
  const router=createRouter({apiKey:'x',fetchImpl:async()=>content('I think you want: no em dashes')});
  await assert.rejects(router.route({projects,context:[],turn:['x']}),error=>{
    assert.equal(error.code,'ROUTER_SHAPE');
    assert.match(error.reason,/nothing usable/);
    return true;
  });
});

test('the schema is enforced by the provider, not asked for in the prompt',async()=>{
  let sent;
  const router=createRouter({apiKey:'x',fetchImpl:async(_url,init)=>{
    sent=JSON.parse(init.body);
    return content(JSON.stringify({memories:[]}));
  }});
  await router.route({projects,context:[],turn:['x']});
  assert.equal(sent.generationConfig.responseMimeType,'application/json');
  const schema=sent.generationConfig.responseJsonSchema??sent.generationConfig.responseSchema;
  assert.deepEqual(Object.keys(schema.properties.memories.items.properties).sort(),
    ['project','source','statement']);
  // And the prompt carries no JSON-shape instructions, because it does not
  // have to any more.
  assert.doesNotMatch(sent.contents[0].parts[0].text,/Reply with JSON only/);
});

/** A 429 shaped the way Google actually sends one: no rate limit headers at
 *  all, and the quota, the limit and the retry delay in the body. */
const limited=(quotaId,retryDelay='0s')=>json({error:{code:429,
  message:`Quota exceeded for metric: x, limit: 1000. Please retry in 0.05s.`,
  details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',
    violations:[{quotaId,quotaValue:'1000'}]},
    {'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay}]}},429);

test('a rate limit is retried once and then surfaces',async()=>{
  let calls=0;
  const router=createRouter({apiKey:'x',fetchImpl:async()=>{
    calls++;
    return limited('GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
  }});
  await assert.rejects(router.route({projects,context:[],turn:['x']}),/rate limited/);
  assert.equal(calls,2,'one retry, not a loop');
});

test('a spent daily quota is reported, not slept on',async()=>{
  // Google answers an exhausted per-day quota with a short retryDelay anyway,
  // which reads like a burst limit and is not one. Waiting it out holds the
  // turn open and fails again, so the turn is given up on instead. Capture
  // missing a turn is the behaviour Satchel had before capture existed.
  let calls=0;
  const started=Date.now();
  const router=createRouter({apiKey:'x',fetchImpl:async()=>{
    calls++;
    return limited('GenerateContentPaidTierInputTokensPerDay','9s');
  }});
  await assert.rejects(router.route({projects,context:[],turn:['x']}),error=>{
    assert.equal(error.code,'ROUTER_LIMIT');
    assert.match(error.reason,/day's free quota is used up \(1000 requests\)/);
    return true;
  });
  assert.equal(calls,1);
  assert.ok(Date.now()-started<500,'and nothing sleeps on the way out');
});

test('a missing key is a configuration error, not a silent no-op',async()=>{
  // null, not undefined. A default parameter only fires on undefined, so
  // `apiKey: undefined` falls back to GEMINI_API_KEY and this passes or fails
  // depending on whether whoever is running it has a key exported.
  const router=createRouter({apiKey:null,fetchImpl:reply([])});
  await assert.rejects(router.route({projects,context:[],turn:['x']}),RouterError);
});

test('JSON wrapped in a fence or a sentence is recovered, and its contents still checked',async()=>{
  // Google native enforces the schema so this never fires there, but an
  // `openai` host that ignores the request still answers in prose, and losing
  // the recovery would quietly stop capture working on that whole path.
  const wrapped=text=>createRouter({apiKey:'x',fetchImpl:async()=>content(text)});
  const payload=JSON.stringify({memories:[{statement:'Tabs in Go.',source:'tabs in go',project:null,task:null}]});
  for(const shape of ['```json\n'+payload+'\n```','Here you go:\n'+payload,payload]){
    const out=await wrapped(shape).route({projects:[],context:[],turn:['i use tabs in go']});
    assert.equal(out.memories.length,1,`failed on ${shape.slice(0,20)}`);
  }
  // recovered, but a fabricated source is still dropped
  const bad=JSON.stringify({memories:[{statement:'Spaces.',source:'i use spaces',project:null,task:null}]});
  const out=await wrapped('```json\n'+bad+'\n```').route({projects:[],context:[],turn:['i use tabs in go']});
  assert.equal(out.memories.length,0,'leniency about the wrapper is not leniency about the contents');
});

test('the router says what it was looking at, on the trace around it',async()=>{
  // These facts used to be passed as telemetry.metadata on the model call. The
  // AI SDK reads per-call metadata off runtimeContext now and generateObject
  // does not take one, so they arrived nowhere: every trace was missing the
  // wording and the scope, and it looked like it worked.
  const seen=[];
  const router=createRouter({apiKey:'k',fetchImpl:reply([]),
    annotate:attributes=>seen.push(attributes),
    promptResolver:async()=>({text:'rules',source:'langfuse',version:7})});
  await router.route({codebase:'neerajg03/satchel',project:{slug:'satchel'},
    projects,context:[{role:'user',content:'earlier'}],turn:['a thing'],saved:[]});
  assert.equal(seen.length,1);
  const {metadata}=seen[0];
  // Without the version a trace from before a prompt change and one from after
  // are indistinguishable, which is what makes capture unmeasurable after the
  // fact.
  assert.equal(metadata.promptName,'satchel-capture-router');
  assert.equal(metadata.promptVersion,7);
  assert.equal(metadata.promptSource,'langfuse');
  // The scope it was handed: the first thing to look at when something files
  // itself in the wrong place.
  assert.equal(metadata.workingOn,'satchel');
  assert.equal(metadata.codebase,'neerajg03/satchel');
  assert.equal(metadata.contextMessages,1);
  assert.equal(metadata.turnMessages,1);
});

test('a router built without tracing still runs',async()=>{
  const router=createRouter({apiKey:'k',fetchImpl:reply([])});
  assert.deepEqual((await router.route({turn:['a thing']})).memories,[]);
});

test('a source quoting a long paste is cut to what memories.source holds, not refused',()=>{
  // memories.source is capped at 4000 in the table. An uncut quote of a long
  // paste failed the insert, and the memory was lost with a check violation.
  const paste='we deploy from main on fridays '.repeat(300);
  const out=validate({memories:[{statement:'Deploys go out on Fridays.',source:paste,project:null}]},
    {turn:[paste],projects:[]});
  assert.equal(out.memories.length,1);
  assert.equal(out.memories[0].source.length,4000);
});
