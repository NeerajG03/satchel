// The consolidation pass, driven the way the job drives it.
//
// The router's own tests cover the model plumbing, so these are about the one
// thing this call can do that the router could not: change a memory that
// already exists. Every check here exists because getting it wrong is
// destructive rather than merely unhelpful.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildConsolidationPrompt, validateConsolidation, createConsolidator,
  CONSOLIDATION_SCHEMA} from '../server/consolidator.mjs';
import {worthWaiting} from '../server/model-provider.mjs';

const projects = [{slug: 'ledger', brief: 'Go payments ledger'}, {slug: 'sourdough', brief: 'Baking'}];
const memories = [
  {id: 'm1', statement: 'No em dashes.', kind: 'preference', project_slug: null, revision: 1, mentions: 2},
  {id: 'm2', statement: 'I want entries to be append only.', kind: 'intent', project_slug: 'ledger', revision: 3, mentions: 1},
  {id: 'm3', statement: 'Deploys go out on Tuesday mornings.', kind: 'fact', project_slug: 'ledger', revision: 1, mentions: 1},
];
const turns = [
  {role: 'user', content: 'done, entries are append only now'},
  {role: 'assistant', content: 'Good. I will treat the ledger as append only from here.'},
  {role: 'user', content: 'and no em dashes in commit messages either'},
];
const context = {turns, memories, project: {slug: 'ledger', brief: 'Go payments ledger'}, projects};

const change = over => ({action: 'add', target: null, statement: 'A claim.', source: 'done, entries are append only',
  kind: 'fact', project: null, expires: null, why: 'because', ...over});

test('the model is told what day it is, and how old each memory is', () => {
  // R7. Nothing had a temporal anchor, which is how "not in the review list
  // this time around" became a permanent memory. A relative reference cannot
  // be resolved by a model that does not know the date, and a claim cannot be
  // doubted by one that does not know its age.
  const {prompt} = buildConsolidationPrompt({...context,
    now: new Date('2026-09-22T09:00:00Z'),
    turns: [{...turns[0], created_at: '2026-09-20T11:00:00Z'}],
    memories: [{...memories[0], affirmed_at: '2026-09-14T08:00:00Z'}]});
  assert.match(prompt, /today is 2026-09-22\. this conversation happened on 2026-09-20/);
  assert.match(prompt, /last on 2026-09-14/);
});

test('the model is shown numbers, never ids', () => {
  const {system, prompt} = buildConsolidationPrompt(context);
  assert.match(system, /You are given one conversation/);
  assert.match(prompt, /#1 {2}\[preference, personal, said 2 times\] {2}No em dashes\./);
  assert.match(prompt, /#2 {2}\[intent, ledger\] {2}I want entries to be append only\./);
  assert.doesNotMatch(prompt, /\bm1\b|\bm2\b/, 'a model that never sees an id cannot invent one');
  assert.match(prompt, /this conversation\n {2}project {2}ledger/);
});

test('both halves of the conversation are shown, in the order they happened', () => {
  const {prompt} = buildConsolidationPrompt(context);
  assert.ok(prompt.indexOf('done, entries are append only now') < prompt.indexOf('Good. I will treat'),
    'the assistant reply is what makes "yes, that one" readable');
  assert.match(prompt, /<conversation>/);
});

test('an empty memory set says so rather than showing an empty list', () => {
  const {prompt} = buildConsolidationPrompt({...context, memories: []});
  assert.match(prompt, /nothing is remembered for this conversation yet/);
});

test('a memory said again unchanged is affirmed rather than written over', () => {
  // Repetition is a precision signal and it was being thrown away. A claim
  // restated across sessions is stronger than one said once.
  const out = validateConsolidation({changes: [
    change({action: 'affirm', target: 1, statement: '', source: 'no em dashes in commit messages'})]}, context);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].target, 'm1');
  assert.equal(out.changes[0].statement, '', 'an affirm carries no wording, because none changed');
});

test('a fulfilled intent can be retired and a standing fact cannot', () => {
  // R2a, and the reason kinds are load bearing twice. A completion ends an
  // intent. Letting one end a fact would quietly delete the most durable rows
  // in the set, which is the worst possible direction for this to fail in.
  const retire = validateConsolidation({changes: [change({action: 'retire', target: 2, statement: ''})]}, context);
  assert.equal(retire.changes.length, 1);
  assert.equal(retire.changes[0].target, 'm2');
  assert.equal(retire.changes[0].revision, 3, 'the revision travels, so a stale run cannot win');

  const fact = validateConsolidation({changes: [change({action: 'retire', target: 3, statement: ''})]}, context);
  assert.deepEqual(fact.changes, []);
  assert.equal(fact.dropped[0].why, 'only an intent can be retired');
});

test('a change to a memory nobody mentioned is dropped, not guessed at', () => {
  const out = validateConsolidation({changes: [
    change({action: 'replace', target: 9, statement: 'Something else.'}),
    change({action: 'extend', target: null, statement: 'Something else.'}),
  ]}, context);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.dropped.map(d => d.why), ['no such memory', 'no such memory']);
});

test('the same memory is only changed once in a run', () => {
  // Two changes to one row means the second fails on a revision it no longer
  // holds, and a model asking for both usually could not decide.
  const out = validateConsolidation({changes: [
    change({action: 'extend', target: 1, statement: 'No em dashes, including in commit messages.'}),
    change({action: 'replace', target: 1, statement: 'Em dashes are fine now.'}),
  ]}, context);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].action, 'extend');
  assert.equal(out.dropped[0].why, 'already changed in this run');
});

test('a source the user never typed ends nothing and adds nothing', () => {
  // The anti-fabrication rule, and it has to cover retires too. Without it an
  // intent can be ended because a model decided it looked finished.
  const out = validateConsolidation({changes: [
    change({source: 'I have decided to use tabs'}),
    change({action: 'retire', target: 2, statement: '', source: 'I will treat the ledger as append only'}),
  ]}, context);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.dropped.map(d => d.why),
    ['source is not in the conversation', 'source is not in the conversation']);
});

test('the assistant’s own words are never a source', () => {
  const out = validateConsolidation({changes: [
    change({source: 'Good. I will treat the ledger as append only from here.'}),
  ]}, context);
  assert.equal(out.changes.length, 0, 'otherwise the model is quoting itself back as evidence');
});

test('an invented project falls back to personal, and a real one survives', () => {
  const out = validateConsolidation({changes: [
    change({project: 'not-a-project', statement: 'One claim.', source: 'no em dashes in commit messages'}),
    change({project: 'sourdough', statement: 'Another claim.', source: 'no em dashes in commit messages'}),
  ]}, context);
  assert.equal(out.changes[0].project, null, 'personal loads everywhere, which is the harmless miss');
  assert.equal(out.changes[1].project, 'sourdough');
});

test('a claim already in the set is not added again', () => {
  const out = validateConsolidation({changes: [
    change({statement: 'no em dashes', source: 'no em dashes in commit messages'}),
  ]}, context);
  assert.deepEqual(out.changes, []);
  assert.equal(out.dropped[0].why, 'already remembered');
});

test('an oversized or missing statement is refused, except on a retire', () => {
  const out = validateConsolidation({changes: [
    change({statement: 'x'.repeat(501)}),
    change({statement: ''}),
    change({action: 'retire', target: 2, statement: ''}),
  ]}, context);
  assert.equal(out.changes.length, 1, 'only the retire, which has no statement by design');
  assert.deepEqual(out.dropped.map(d => d.why),
    ['statement missing or too long', 'statement missing or too long']);
});

test('an unknown kind is refused rather than defaulted', () => {
  const out = validateConsolidation({changes: [change({kind: 'episode'})]}, context);
  assert.equal(out.dropped[0].why, 'unknown kind');
});

const json = (body, status = 200) => new Response(JSON.stringify(body),
  {status, headers: {'content-type': 'application/json'}});
const answers = changes => async () => json({
  candidates: [{content: {parts: [{text: JSON.stringify({changes})}]}, finishReason: 'STOP'}],
  usageMetadata: {promptTokenCount: 900, candidatesTokenCount: 60, totalTokenCount: 960}});

test('a run comes back explainable, with the prompt, the reply and the wording it used', async () => {
  const consolidator = createConsolidator({apiKey: 'x', fetchImpl: answers([
    {action: 'retire', target: 2, statement: '', source: 'done, entries are append only',
     kind: 'intent', project: 'ledger', expires: null, why: 'the user said it was done'}])});
  const out = await consolidator.consolidate(context);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].target, 'm2');
  assert.match(out.prompt, /You are given one conversation/, 'the system half is in the record too');
  assert.match(out.raw, /"action":"retire"/);
  assert.equal(out.promptSource, 'local');
});

test('the run says what it was looking at before it says what it did', async () => {
  // R11. A background pass that writes memory while nobody is watching is
  // unauditable unless the trace carries the input as well as the output.
  const seen = [];
  const consolidator = createConsolidator({apiKey: 'x', fetchImpl: answers([]),
    annotate: entry => seen.push(entry)});
  await consolidator.consolidate(context);
  assert.equal(seen[0].metadata.scope, 'ledger');
  assert.equal(seen[0].metadata.thinking, 'medium');
  assert.equal(seen[0].metadata.knownMemories, 3);
  assert.equal(seen[0].metadata.turns, 3);
  assert.equal(seen[0].metadata.promptName, 'satchel-consolidate');
});

test('the schema the provider enforces is the five decisions and nothing else', async () => {
  let sent;
  const consolidator = createConsolidator({apiKey: 'x', fetchImpl: async (_url, init) => {
    sent = JSON.parse(init.body);
    return json({candidates: [{content: {parts: [{text: '{"changes":[]}'}]}, finishReason: 'STOP'}]});
  }});
  await consolidator.consolidate(context);
  const schema = sent.generationConfig.responseJsonSchema ?? sent.generationConfig.responseSchema;
  assert.deepEqual(Object.keys(schema.properties.changes.items.properties).sort(),
    ['action', 'expires', 'kind', 'project', 'source', 'statement', 'target', 'why']);
  assert.deepEqual(CONSOLIDATION_SCHEMA.shape.changes.element.shape.action.options,
    ['add', 'extend', 'replace', 'retire', 'affirm']);
});

test('nothing to change is a real answer', async () => {
  const out = await createConsolidator({apiKey: 'x', fetchImpl: answers([])}).consolidate(context);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.dropped, []);
});

test('an expiry is kept only when it is a date the user could have given', () => {
  // A memory that disappears on a day nobody chose is worse than one that
  // stays too long, because nobody notices it went. Everything doubtful is
  // dropped rather than corrected.
  const now = new Date('2026-09-22T00:00:00Z');
  const of = expires => validateConsolidation({changes: [change({expires})]}, {...context, now})
    .changes[0].expires;
  assert.equal(of('2026-10-30'), new Date('2026-10-30').toISOString());
  assert.equal(of(null), null);
  assert.equal(of('the thirtieth'), null, 'not a date');
  assert.equal(of('2026-09-01'), null, 'already past');
  assert.equal(of('2199-01-01'), null, 'further out than anyone states a deadline');
});

test('a full block turns the question from absolute into comparative', () => {
  // R3. "Is this durable forever" is the question the old 2000 word prompt
  // kept getting wrong. "Is this worth more than the weakest line already
  // here" is one a small model can answer, and it only exists once the set
  // has a size.
  const many = Array.from({length: 30}, (_, i) =>
    ({id: `m${i}`, statement: `Claim ${i}.`, kind: 'fact', project_slug: null, revision: 1, mentions: 1}));
  const full = buildConsolidationPrompt({...context, memories: many, cap: 30}).prompt;
  assert.match(full, /the block holds 30 and there are already 30/);
  assert.match(full, /worth more than the weakest line above/);

  const roomy = buildConsolidationPrompt({...context, memories: many.slice(0, 5), cap: 30}).prompt;
  assert.doesNotMatch(roomy, /the block holds/, 'no pressure is invented when there is room');
});

const overloaded = () => new Response(JSON.stringify({error: {code: 503, status: 'UNAVAILABLE'}}),
  {status: 503, headers: {'content-type': 'application/json'}});
const answered = () => json({candidates: [{content: {parts: [{text: '{"changes":[]}'}]}, finishReason: 'STOP'}]});
const modelOf = url => String(url).match(/models\/([^:]+):/)?.[1];

test('an overloaded model is waited for and asked again, never swapped for another', async () => {
  // On 23 September one 503 from gemini-3.8-flash sent the last eight
  // sessions of a pass to gemini-3.5-flash, and they were the ones it read
  // worst. The 503s themselves cleared on the second or third try.
  const asked = [], slept = [];
  const consolidator = createConsolidator({apiKey: 'x', model: 'busy-model', annotate: () => {},
    sleep: async ms => { slept.push(ms); },
    fetchImpl: async url => { asked.push(modelOf(url)); return asked.length === 1 ? overloaded() : answered(); }});
  const out = await consolidator.consolidate(context);
  assert.deepEqual(asked, ['busy-model', 'busy-model']);
  assert.deepEqual(slept, [120000], 'two minutes, once');
  assert.equal(out.model, 'busy-model');
});

test('a model still down after the wait is reported, and the session is left for later', async () => {
  const asked = [];
  const consolidator = createConsolidator({apiKey: 'x', model: 'busy', sleep: async () => {},
    fetchImpl: async url => { asked.push(modelOf(url)); return overloaded(); }});
  await assert.rejects(consolidator.consolidate(context), /503|unavailable|could not answer/i);
  assert.deepEqual(asked, ['busy', 'busy'], 'twice, and never a third time or another model');
});

test('with no room left to wait, the caller hears later instead of a wait that cannot finish', async () => {
  const slept = [];
  const consolidator = createConsolidator({apiKey: 'x', model: 'busy', sleep: async ms => { slept.push(ms); },
    fetchImpl: async () => overloaded()});
  await assert.rejects(consolidator.consolidate(context, {deadline: Date.now() + 60000}),
    error => error.later === true);
  assert.deepEqual(slept, []);
});

test('a refusal is not waited for', async () => {
  // A 400 is the request, and the same request is refused the same way two
  // minutes later.
  const asked = [], slept = [];
  const consolidator = createConsolidator({apiKey: 'x', model: 'a', sleep: async ms => { slept.push(ms); },
    fetchImpl: async url => {
      asked.push(modelOf(url));
      return new Response(JSON.stringify({error: {code: 400, status: 'INVALID_ARGUMENT'}}),
        {status: 400, headers: {'content-type': 'application/json'}});
    }});
  await assert.rejects(consolidator.consolidate(context));
  assert.deepEqual(asked, ['a']);
  assert.deepEqual(slept, []);
});

test('what is worth waiting for: an overloaded host and a burst limit, not a spent quota', () => {
  // The day's quota is gone until midnight Pacific, so the job stops on it.
  // A burst limit and a 503 come back on their own.
  assert.equal(worthWaiting({code: 'ROUTER_HOST', status: 503}), true);
  assert.equal(worthWaiting({code: 'ROUTER_LIMIT', spent: false}), true);
  assert.equal(worthWaiting({code: 'ROUTER_LIMIT', spent: true}), false);
  assert.equal(worthWaiting({code: 'ROUTER_HOST', status: 400}), false, 'a bad request is refused identically');
  assert.equal(worthWaiting({code: 'ROUTER_TIMEOUT'}), false, 'the budget is already spent');
  assert.equal(worthWaiting({code: 'ROUTER_SHAPE'}), false, 'that is the prompt, not the host');
});

test('a source quoting a long paste is cut to what memories.source holds, not refused', () => {
  const paste = 'we deploy from main on fridays '.repeat(300);
  const out = validateConsolidation({changes: [{action: 'add', statement: 'Deploys go out on Fridays.',
    source: paste, kind: 'fact', why: 'said so', project: null}]},
    {turns: [{role: 'user', content: paste}], memories: [], projects: []});
  assert.equal(out.changes.length, 1, JSON.stringify(out.dropped));
  assert.equal(out.changes[0].source.length, 4000);
});
