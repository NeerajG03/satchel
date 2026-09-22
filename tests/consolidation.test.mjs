// The background pass, as the job runs it.
//
// consolidator.test.mjs covers what the model is asked and what is refused.
// This is the other half: what actually gets written, in what order, and what
// happens when one of those writes fails. Nobody is watching this run, so the
// failure modes matter more than the happy path.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consolidateDocument, consolidatePending} from '../server/consolidation.mjs';

const document = {id: 'd1', session_key: 's1', project_id: 'p1', turns: 3,
  consolidated_through: null, last_turn_at: '2026-09-22T06:00:00Z'};
const projects = [{id: 'p1', slug: 'ledger', brief: 'Go payments ledger'},
  {id: 'p2', slug: 'sourdough', brief: 'Baking'}];
const memories = [
  {id: 'm1', statement: 'I want entries to be append only.', kind: 'intent', revision: 3},
  {id: 'm2', statement: 'No em dashes.', kind: 'preference', revision: 1},
];
const turns = [{id: 10, role: 'user', content: 'done, entries are append only now'},
  {id: 11, role: 'assistant', content: 'Understood.'}];

function fake({changes = [], dropped = [], fail = null, writes = {}} = {}) {
  const calls = [];
  const service = {
    documentTurns: async (id, after) => { calls.push({call: 'turns', id, after}); return turns; },
    memoriesInScope: async projectId => { calls.push({call: 'memories', projectId}); return memories; },
    projects: async () => projects,
    pendingDocuments: async () => [document],
    captureMemory: async args => {
      calls.push({call: 'capture', ...args});
      if (writes.capture) throw writes.capture;
      return {id: 'new1', statement: args.statement};
    },
    extendMemory: async args => { calls.push({call: 'extend', ...args}); if (writes.extend) throw writes.extend; return {id: args.id}; },
    endMemory: async args => { calls.push({call: 'end', ...args}); if (writes.end) throw writes.end; return {id: args.id}; },
    markDocumentConsolidated: async (id, through) => { calls.push({call: 'marked', id, through}); },
    logConsolidationRun: async entry => { calls.push({call: 'logged', ...entry}); },
    settings: async () => ({block_size: 30}),
  };
  const consolidator = {
    model: 'test-model',
    consolidate: async (input, options = {}) => {
      calls.push({call: 'consolidate', input, options});
      if (fail) throw fail;
      return {changes, dropped, prompt: 'the prompt', raw: '{}', usage: {inputTokens: 900, outputTokens: 20}};
    },
  };
  return {service, consolidator, calls, of: name => calls.filter(c => c.call === name)};
}

test('a fulfilled intent is retired and the run says so', async () => {
  const {service, consolidator, of} = fake({changes: [
    {action: 'retire', target: 'm1', revision: 3, statement: '', source: 'done, entries are append only',
     kind: 'intent', project: 'ledger', why: 'the user said it was done'}]});
  const result = await consolidateDocument(service, consolidator, document, {projects});
  assert.equal(result.retired, 1);
  const [ended] = of('end');
  assert.equal(ended.id, 'm1');
  assert.equal(ended.revision, 3, 'the revision travels, so a stale decision loses');
  assert.equal(ended.reason, 'retired');
  assert.equal(ended.document, 'd1');
});

test('a replacement writes the new claim before it ends the old one', async () => {
  // If ending fails after the write, the set holds both, which is untidy and
  // true. The other order loses the claim and leaves nothing saying it was
  // ever made.
  const {service, consolidator, calls} = fake({changes: [
    {action: 'replace', target: 'm2', revision: 1, statement: 'Em dashes are fine in quotes.',
     source: 'em dashes are fine in quotes', kind: 'preference', project: null, why: 'narrowed'}]});
  const result = await consolidateDocument(service, consolidator, document, {projects});
  assert.equal(result.replaced, 1);
  const order = calls.filter(c => c.call === 'capture' || c.call === 'end').map(c => c.call);
  assert.deepEqual(order, ['capture', 'end']);
  const [ended] = calls.filter(c => c.call === 'end');
  assert.equal(ended.ended_by, 'new1', 'the old row points at what replaced it');
});

test('one write that fails does not cost the rest of the run', async () => {
  const {service, consolidator, of} = fake({
    writes: {extend: Object.assign(new Error('conflict'), {code: 'PT409'})},
    changes: [
      {action: 'extend', target: 'm2', revision: 1, statement: 'No em dashes anywhere.',
       source: 'no em dashes', kind: 'preference', project: null, why: 'more specific'},
      {action: 'retire', target: 'm1', revision: 3, statement: '', source: 'done, entries are append only',
       kind: 'intent', project: 'ledger', why: 'done'}]});
  const result = await consolidateDocument(service, consolidator, document, {projects});
  assert.equal(result.extended, 0);
  assert.equal(result.retired, 1, 'the second change still happens');
  assert.equal(result.dropped, 1, 'and the failure is counted rather than swallowed');
  assert.equal(of('marked').length, 1, 'a partly applied document is still read');
});

test('a run that never reached the model leaves the document pending', async () => {
  const {service, consolidator, of} = fake({fail: Object.assign(new Error('rate limited'),
    {code: 'ROUTER_LIMIT', reason: 'consolidation is rate limited'})});
  const result = await consolidateDocument(service, consolidator, document, {projects});
  assert.match(result.failed, /rate limited/);
  assert.deepEqual(of('marked'), [], 'nothing was decided, so the next pass must ask again');
  const [logged] = of('logged');
  assert.equal(logged.prompt, '(not sent)');
  assert.match(logged.error, /rate limited/);
});

test('a run that changed nothing is still recorded', async () => {
  // The quiet runs are most of them, and a pass whose quiet answers are
  // invisible cannot be argued with after the fact.
  const {service, consolidator, of} = fake({changes: []});
  const result = await consolidateDocument(service, consolidator, document, {projects});
  assert.deepEqual({added: result.added, extended: result.extended, replaced: result.replaced,
    retired: result.retired, dropped: result.dropped}, {added: 0, extended: 0, replaced: 0, retired: 0, dropped: 0});
  const [logged] = of('logged');
  assert.equal(logged.prompt, 'the prompt');
  assert.equal(logged.input_tokens, 900, 'what it cost is part of what it did');
  assert.equal(typeof logged.duration_ms, 'number');
  assert.equal(of('marked')[0].through, 11, 'and the document does not come back');
});

test('only the turns nobody has read are read', async () => {
  const {service, consolidator, of} = fake();
  await consolidateDocument(service, consolidator, {...document, consolidated_through: 9}, {projects});
  assert.equal(of('turns')[0].after, 9);
});

test('a document with nothing new costs no model call', async () => {
  const {service, consolidator, of} = fake();
  service.documentTurns = async () => [];
  const result = await consolidateDocument(service, consolidator, document, {projects});
  assert.equal(result.skipped, 'nothing new');
  assert.deepEqual(of('consolidate'), []);
  assert.deepEqual(of('logged'), [], 'and nothing to explain');
});

test('the scope it was in is what it is judged against', async () => {
  const {service, consolidator, of} = fake();
  await consolidateDocument(service, consolidator, document, {projects});
  assert.equal(of('memories')[0].projectId, 'p1');
  const [{input}] = of('consolidate');
  assert.deepEqual(input.project, {slug: 'ledger', brief: 'Go payments ledger'});
  assert.deepEqual(input.projects, [{slug: 'sourdough', brief: 'Baking'}],
    'the one it is in is named on its own, not repeated among the others');
  assert.equal(input.turns.length, 2, 'both roles, because one explains the other');
});

test('a personal document is judged against personal memory alone', async () => {
  const {service, consolidator, of} = fake();
  await consolidateDocument(service, consolidator, {...document, project_id: null}, {projects});
  assert.equal(of('memories')[0].projectId, null);
  assert.equal(of('consolidate')[0].input.project, null);
});

test('the run carries the trace that decided it, onto every row it writes', async () => {
  // R11. A row in the database and the reasoning that produced it have to be
  // one step apart in both directions, or a background writer is exactly as
  // unauditable as the design it replaces.
  const traced = (_name, _options, run) => run(() => {}, () => {}, 'trace-abc');
  const {service, consolidator, of} = fake({changes: [
    {action: 'add', target: null, statement: 'Deploys are on Tuesdays.', source: 'deploys are on tuesdays',
     kind: 'fact', project: 'ledger', why: 'they said so'}]});
  await consolidateDocument(service, consolidator, document, {projects, traced});
  assert.equal(of('capture')[0].trace, 'trace-abc');
  assert.equal(of('capture')[0].kind, 'fact');
  assert.equal(of('capture')[0].project, 'ledger');
  assert.equal(of('logged')[0].trace_id, 'trace-abc');
});

test('nothing pending costs nothing at all', async () => {
  const {service, consolidator} = fake();
  service.pendingDocuments = async () => [];
  const result = await consolidatePending(service, consolidator);
  assert.deepEqual(result, {documents: 0, remaining: 0, runs: []});
});

test('the block cap the session injects under is the one the pass judges against', async () => {
  const {service, consolidator, of} = fake();
  service.settings = async () => ({block_size: 12});
  await consolidatePending(service, consolidator);
  assert.equal(of('consolidate')[0].input.cap, 12);
});

test('the projects are read once for the batch, not once per document', async () => {
  const {service, consolidator} = fake();
  let reads = 0;
  service.projects = async () => { reads += 1; return projects; };
  service.pendingDocuments = async () => [document, {...document, id: 'd2', session_key: 's2'}];
  const result = await consolidatePending(service, consolidator, {limit: 5});
  assert.equal(result.documents, 2);
  assert.equal(reads, 1);
});

test('a batch stops on the clock rather than being killed partway', async () => {
  // One document is now a thinking model reading a whole session, so a
  // backlog no longer reliably fits in one serverless request. Running out of
  // time has to be an answer, not a 504: what was read is marked, what was
  // not stays pending, and the caller is told how much is left.
  const {service, consolidator, of} = fake();
  service.pendingDocuments = async () => [document, {...document, id: 'd2', session_key: 's2'},
    {...document, id: 'd3', session_key: 's3'}];
  let slept = 0;
  consolidator.consolidate = async () => {
    slept += 40;
    await new Promise(done => setTimeout(done, 40));
    return {changes: [], dropped: [], prompt: 'p', raw: '{}', usage: null};
  };
  const result = await consolidatePending(service, consolidator, {budgetMs: 60});
  assert.ok(result.documents >= 1 && result.documents < 3,
    `read what it had time for, not all three (read ${result.documents})`);
  assert.equal(result.remaining, 3 - result.documents, 'and says how much is left');
  assert.equal(of('marked').length, result.documents, 'only what was read is marked');
  void slept;
});

test('the call is bounded by the caller’s deadline, not only its own timeout', async () => {
  // The model timeout is 40 seconds and the function has 60 for everything.
  // Without this the last document of a batch starts at second 55 and the
  // request is killed mid-write, which is the one failure that can leave a
  // document half applied and unmarked.
  const {service, consolidator, of} = fake();
  const deadline = Date.now() + 5000;
  await consolidateDocument(service, consolidator, document, {projects, deadline});
  assert.equal(of('consolidate')[0].options.deadline, deadline,
    'the model call has to know the wall, or it happily runs past it');
});
