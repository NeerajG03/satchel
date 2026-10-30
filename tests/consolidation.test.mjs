// The background pass, as the job runs it.
//
// consolidator.test.mjs covers what the model is asked and what is refused.
// This is the other half: what actually gets written, in what order, and what
// happens when one of those writes fails. Nobody is watching this run, so the
// failure modes matter more than the happy path.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consolidateDocument, consolidatePending} from '../server/consolidation.mjs';

const document = {id: 'd1', session_key: 's1', topic_id: 'p1', turns: 3,
  consolidated_through: null, last_turn_at: '2026-09-22T06:00:00Z'};
const topics = [{id: 'p1', slug: 'ledger', brief: 'Go payments ledger'},
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
    memoriesInScope: async topicId => { calls.push({call: 'memories', topicId}); return memories; },
    topics: async () => topics,
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
     kind: 'intent', topic: 'ledger', why: 'the user said it was done'}]});
  const result = await consolidateDocument(service, consolidator, document, {topics});
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
     source: 'em dashes are fine in quotes', kind: 'preference', topic: null, why: 'narrowed'}]});
  const result = await consolidateDocument(service, consolidator, document, {topics});
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
       source: 'no em dashes', kind: 'preference', topic: null, why: 'more specific'},
      {action: 'retire', target: 'm1', revision: 3, statement: '', source: 'done, entries are append only',
       kind: 'intent', topic: 'ledger', why: 'done'}]});
  const result = await consolidateDocument(service, consolidator, document, {topics});
  assert.equal(result.extended, 0);
  assert.equal(result.retired, 1, 'the second change still happens');
  assert.equal(result.dropped, 1, 'and the failure is counted rather than swallowed');
  assert.equal(of('marked').length, 1, 'a partly applied document is still read');
});

test('a run that never reached the model leaves the document pending', async () => {
  const {service, consolidator, of} = fake({fail: Object.assign(new Error('rate limited'),
    {code: 'ROUTER_LIMIT', reason: 'consolidation is rate limited'})});
  const result = await consolidateDocument(service, consolidator, document, {topics});
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
  const result = await consolidateDocument(service, consolidator, document, {topics});
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
  await consolidateDocument(service, consolidator, {...document, consolidated_through: 9}, {topics});
  assert.equal(of('turns')[0].after, 9);
});

test('a document with nothing new costs no model call', async () => {
  const {service, consolidator, of} = fake();
  service.documentTurns = async () => [];
  const result = await consolidateDocument(service, consolidator, document, {topics});
  assert.equal(result.skipped, 'nothing new');
  assert.deepEqual(of('consolidate'), []);
  assert.deepEqual(of('logged'), [], 'and nothing to explain');
});

test('the scope it was in is what it is judged against', async () => {
  const {service, consolidator, of} = fake();
  await consolidateDocument(service, consolidator, document, {topics});
  assert.equal(of('memories')[0].topicId, 'p1');
  const [{input}] = of('consolidate');
  assert.deepEqual(input.topic, {slug: 'ledger', brief: 'Go payments ledger'});
  assert.deepEqual(input.topics, [{slug: 'sourdough', brief: 'Baking', repositories: []}],
    'the one it is in is named on its own, not repeated among the others');
  assert.equal(input.turns.length, 2, 'both roles, because one explains the other');
});

test('the run carries the trace that decided it, onto every row it writes', async () => {
  // R11. A row in the database and the reasoning that produced it have to be
  // one step apart in both directions, or a background writer is exactly as
  // unauditable as the design it replaces.
  const traced = (_name, _options, run) => run(() => {}, () => {}, 'trace-abc');
  const {service, consolidator, of} = fake({changes: [
    {action: 'add', target: null, statement: 'Deploys are on Tuesdays.', source: 'deploys are on tuesdays',
     kind: 'fact', topic: 'ledger', why: 'they said so'}]});
  await consolidateDocument(service, consolidator, document, {topics, traced});
  assert.equal(of('capture')[0].trace, 'trace-abc');
  assert.equal(of('capture')[0].kind, 'fact');
  assert.equal(of('capture')[0].topic, 'ledger');
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

test('the topics are read once for the batch, not once per document', async () => {
  const {service, consolidator} = fake();
  let reads = 0;
  service.topics = async () => { reads += 1; return topics; };
  service.pendingDocuments = async () => [document, {...document, id: 'd2', session_key: 's2'}];
  const result = await consolidatePending(service, consolidator);
  assert.equal(result.documents, 2);
  assert.equal(reads, 1);
});

test('every waiting session is read, not the first ten', async () => {
  // The cap of ten left three sessions unread on 22 September with time to
  // spare. The service is asked for no count, and all of them are read.
  const {service, consolidator, of} = fake();
  const asked = [];
  const many = Array.from({length: 25}, (_, i) => ({...document, id: `d${i}`, session_key: `s${i}`}));
  service.pendingDocuments = async (...args) => { asked.push(args); return many; };
  const result = await consolidatePending(service, consolidator);
  assert.deepEqual(asked, [[30]], 'no limit is passed down');
  assert.equal(result.documents, 25);
  assert.equal(result.remaining, 0);
  assert.equal(of('marked').length, 25);
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
  await consolidateDocument(service, consolidator, document, {topics, deadline});
  assert.equal(of('consolidate')[0].options.deadline, deadline,
    'the model call has to know the wall, or it happily runs past it');
});

test('a session with no topic is shown every topic\'s memories, once each', async () => {
  // It can file under a topic now, so it has to see what that topic
  // already holds, or it adds what is there and can never extend it.
  const {service, consolidator, of} = fake();
  const limits = {};
  service.memoriesInScope = async (topicId, limit) => {
    limits[topicId] = limit;
    return topicId === 'p1'
      ? [{id: 'm2', statement: 'No em dashes.', kind: 'preference', topic_id: null},
         {id: 'm1', statement: 'I want entries to be append only.', kind: 'intent', topic_id: 'p1', topic_slug: 'ledger'}]
      : [{id: 'm2', statement: 'No em dashes.', kind: 'preference', topic_id: null}];
  };
  const repoed = [{...topics[0], topic_repositories: [{provider: 'github', repository: 'acme/ledger'}]}, topics[1]];
  await consolidateDocument(service, consolidator, {...document, topic_id: null}, {topics: repoed});
  const [{input}] = of('consolidate');
  assert.deepEqual(input.memories.map(m => m.id), ['m2', 'm1'], 'personal first, no repeats');
  assert.equal(input.topic, null);
  assert.deepEqual(input.topics.map(p => [p.slug, p.repositories]), [['ledger', ['acme/ledger']], ['sourdough', []]]);
  assert.deepEqual(limits, {null: 200, p1: 1000, p2: 1000}, 'personal rows do not crowd out a topic\'s own');
});

test('a topic\'s memories still reach a session with no topic when personal memory is large', async () => {
  // memories_in_scope returns personal rows first, then the topic's own, and
  // cuts at the limit. With 131 personal rows the old limit of 120 returned
  // personal rows only, so 60 of 173 sessions in one review saw no topic
  // memory and could neither extend nor affirm one.
  const {service, consolidator, of} = fake();
  const personal = Array.from({length: 131}, (_, i) =>
    ({id: `u${i}`, statement: `Personal rule ${i}.`, kind: 'preference', topic_id: null}));
  const owned = {id: 't1', statement: 'Entries are append only.', kind: 'fact', topic_id: 'p1', topic_slug: 'ledger'};
  service.memoriesInScope = async (topicId, limit) =>
    [...personal, ...(topicId === 'p1' ? [owned] : [])].slice(0, limit);
  await consolidateDocument(service, consolidator, {...document, topic_id: null}, {topics});
  const [{input}] = of('consolidate');
  assert.ok(input.memories.some(m => m.id === 't1'), 'the topic memory is in what the pass was shown');
  assert.equal(input.memories.filter(m => !m.topic_id).length, 131, 'and so is every personal one');
});

test('the pass asks how old each memory it was shown is, and the prompt says so', async () => {
  // None of the read functions returns created_at, so the pass reads it by
  // id after the scoped read and merges it onto the rows. A row the read did
  // not return keeps none and is shown as before.
  const {service, consolidator, calls, of} = fake();
  service.ages = async ids => {
    calls.push({call: 'ages', ids});
    return [{id: 'm1', created_at: '2026-09-21T08:00:00Z', mentions: 1}];
  };
  consolidator.consolidate = async input => {
    calls.push({call: 'consolidate', input, options: {}});
    const {buildConsolidationPrompt} = await import('../server/consolidator.mjs');
    const {prompt} = buildConsolidationPrompt({...input, now: new Date('2026-09-22T09:00:00Z')});
    return {changes: [], dropped: [], prompt, raw: '{}', usage: {}};
  };
  await consolidateDocument(service, consolidator, document, {topics});
  assert.deepEqual(of('ages').map(c => c.ids), [['m1', 'm2']], 'asked once, for exactly the rows it was shown');
  const [{input}] = of('consolidate');
  assert.equal(input.memories[0].created_at, '2026-09-21T08:00:00Z');
  assert.equal(input.memories[0].revision, 3, 'the read\'s own fields survive the merge');
  assert.equal('created_at' in input.memories[1], false, 'a row ages did not return keeps none');
  const [logged] = of('logged');
  assert.match(logged.prompt, /#1 {2}\[intent, personal, made on 2026-09-21\]/);
  assert.match(logged.prompt, /#2 {2}\[preference, personal\] {2}No em dashes\./);
});

test('a service without ages, or whose ages throws, still runs the pass', async () => {
  // The dates are the newest thing in the prompt and the least load bearing.
  // A fake service or an older one has no ages; a read that fails must cost
  // the dates and nothing else.
  const without = fake();
  assert.equal('ages' in without.service, false);
  const quiet = await consolidateDocument(without.service, without.consolidator, document, {topics});
  assert.equal(quiet.skipped, undefined);
  assert.equal(without.of('consolidate').length, 1);
  assert.equal('created_at' in without.of('consolidate')[0].input.memories[0], false);

  const failing = fake();
  failing.service.ages = async () => { throw new Error('connection reset'); };
  const result = await consolidateDocument(failing.service, failing.consolidator, document, {topics});
  assert.equal(result.skipped, undefined);
  assert.equal(result.error, undefined, 'a failed age read is not a failed pass');
  assert.equal(failing.of('consolidate').length, 1, 'the model is still asked');
  assert.equal(failing.of('marked').length, 1, 'and the document is still marked read');
});

test('a person with no topics is judged against personal memory alone', async () => {
  const {service, consolidator, of} = fake();
  await consolidateDocument(service, consolidator, {...document, topic_id: null}, {topics: []});
  assert.deepEqual(of('memories').map(c => c.topicId), [null]);
  assert.equal(of('consolidate')[0].input.topic, null);
});

test('a session too long for one call is read in pieces, none of it cut, each piece marked', async () => {
  const big = 'a'.repeat(200_000);
  const all = [{id: 10, role: 'user', content: big}, {id: 11, role: 'user', content: big + ' end'}];
  const {service, consolidator, of} = fake();
  service.documentTurns = async (id, after) => all.filter(t => after == null || t.id > after);
  const result = await consolidateDocument(service, consolidator, document, {topics});
  const sent = of('consolidate').map(c => c.input.turns.map(t => t.content.length));
  assert.deepEqual(sent, [[200_000], [200_004]], 'the whole turn goes, the rest waits for its own call');
  assert.deepEqual(of('marked').map(m => m.through), [10, 11]);
  assert.equal(result.document, 'd1');
});

test('the codebase goes to the pass only when no topic was chosen', async () => {
  for (const [doc, want] of [[{...document, topic_id: null, repository: 'acme/ledger'}, 'acme/ledger'],
    [{...document, repository: 'acme/ledger'}, null], [{...document, topic_id: null}, null]]) {
    const {service, consolidator, of} = fake();
    await consolidateDocument(service, consolidator, doc, {topics});
    assert.equal(of('consolidate')[0].input.codebase, want);
  }
});

test('an add next to a live twin is a question for the model, and its answer is applied', async () => {
  // Similarity finds the twin but cannot say what it is: on the production
  // embedding a contradiction scores higher than a paraphrase. So the pair is
  // put to the model, and each of its four answers maps to one write.
  const twin = {id: 'm9', topic_id: null, revision: 4, kind: 'preference', statement: 'Explain technical terms simply.', score: 0.88};
  const run = async verdict => {
    const asked = [];
    const {service, consolidator, of, calls} = fake({changes: [
      {action: 'add', statement: 'Explain things in grade school English.', source: 'explain it simply',
       kind: 'preference', topic: null, why: 'said again'}]});
    service.nearest = async () => twin;
    service.affirmMemory = async (id, meta) => { calls.push({call: 'affirm', id, ...meta}); };
    consolidator.reconsider = async input => { asked.push(input); return verdict; };
    const result = await consolidateDocument(service, consolidator, document, {topics});
    return {result, asked, of, calls};
  };

  const affirmed = await run({action: 'affirm', statement: '', why: 'same rule'});
  assert.equal(affirmed.asked[0].existing.id, 'm9');
  assert.equal(affirmed.asked[0].proposed.source, 'explain it simply');
  assert.equal(affirmed.result.affirmed, 1);
  assert.equal(affirmed.of('capture').length, 0, 'no second row');
  assert.equal(affirmed.result.actions[0].on, 'm9');
  assert.match(affirmed.result.actions[0].why, /same rule/);

  const extended = await run({action: 'extend', statement: 'Explain technical terms simply, in grade school English.', why: 'more specific'});
  assert.equal(extended.result.extended, 1);
  const [ext] = extended.of('extend');
  assert.equal(ext.id, 'm9');
  assert.equal(ext.revision, 4, 'the twin\'s revision travels');
  assert.match(ext.statement, /grade school/);

  const replaced = await run({action: 'replace', statement: 'Explain things in grade school English.', why: 'now false'});
  assert.equal(replaced.result.replaced, 1);
  const order = replaced.calls.filter(c => c.call === 'capture' || c.call === 'end').map(c => c.call);
  assert.deepEqual(order, ['capture', 'end'], 'the new claim is written before the old one ends');
  assert.equal(replaced.of('end')[0].id, 'm9');

  const added = await run({action: 'add', statement: '', why: 'different claims'});
  assert.equal(added.result.added, 1);
  assert.equal(added.of('capture').length, 1);
});

test('a replace verdict keeps the successor where the twin lived', async () => {
  // A personal rule loads in every session. A replace proposed from inside
  // one topic must not narrow it to that topic: nobody said it should.
  const {service, consolidator, of} = fake({changes: [
    {action: 'add', statement: 'Explain things in grade school English.', source: 'explain it simply',
     kind: 'preference', topic: 'ledger', why: 'said again'}]});
  service.nearest = async () => ({id: 'm9', topic_id: null, revision: 2, kind: 'preference', statement: 'Explain simply.'});
  consolidator.reconsider = async () => ({action: 'replace', statement: 'Explain things in grade school English.', why: 'narrower', raw: '{"action":"replace"}'});
  const result = await consolidateDocument(service, consolidator, document, {topics});
  assert.equal(result.replaced, 1);
  assert.equal(of('capture')[0].topic, null, 'the successor stays personal');
  assert.deepEqual(result.actions[0].asked, {action: 'replace', twin: 'm9', raw: '{"action":"replace"}'},
    'the run row says what decided the write');
});

test('when the model cannot be asked about a twin, the add goes through as before', async () => {
  const {service, consolidator, of} = fake({changes: [
    {action: 'add', statement: 'Explain things in grade school English.', source: 'explain it simply',
     kind: 'preference', topic: null, why: 'said again'}]});
  service.nearest = async () => ({id: 'm9', topic_id: null, revision: 1, statement: 'Explain simply.'});
  service.affirmMemory = async () => { throw new Error('must not affirm on the score alone'); };
  consolidator.reconsider = async () => { throw new Error('503'); };
  const result = await consolidateDocument(service, consolidator, document, {topics});
  assert.equal(result.added, 1);
  assert.equal(of('capture').length, 1);
});

test('a twin in another topic does not stop the add, and no twin adds as before', async () => {
  const {service, consolidator, of} = fake({changes: [
    {action: 'add', statement: 'Deploys go through the shared pipeline.', source: 'deploy through the shared pipeline',
     kind: 'fact', topic: 'ledger', why: 'a rule'}]});
  service.nearest = async () => ({id: 'm8', topic_id: 'p2', statement: 'Deploys go through the shared pipeline.', score: 0.99});
  service.affirmMemory = async () => { throw new Error('must not affirm across topics'); };
  consolidator.reconsider = async () => { throw new Error('must not be asked about a twin in another topic'); };
  const across = await consolidateDocument(service, consolidator, document, {topics});
  assert.equal(across.added, 1, 'the same rule can hold in two topics');

  const plain = fake({changes: [
    {action: 'add', statement: 'Something new.', source: 'something new', kind: 'fact', topic: null, why: 'new'}]});
  const result = await consolidateDocument(plain.service, plain.consolidator, document, {topics});
  assert.equal(result.added, 1, 'a service without nearest() adds as it always did');
  assert.equal(plain.of('capture').length, 1);
});

test('a claim the person forgot is not written again, and the run says why', async () => {
  // The em-dash rule was forgotten from the archive on 27 September and the
  // pass wrote it again on 6 October, because the twin check only sees live
  // rows. A forget is the person's decision, so the add is refused, named in
  // the run, and the model is not asked about it.
  const {service, consolidator, of, calls} = fake({changes: [
    {action: 'add', statement: 'Do not use em dashes in text.', source: 'no em dashes please',
     kind: 'preference', topic: null, why: 'said again'}]});
  service.forgottenTwin = async statement => {
    calls.push({call: 'forgotten', statement});
    return {id: 'm7', topic_id: null, statement: 'Do not use em dashes.', ended_at: '2026-09-27T10:00:00Z', score: 0.93};
  };
  service.nearest = async () => null;
  consolidator.reconsider = async () => { throw new Error('the model must not be asked about a forgotten claim'); };
  const result = await consolidateDocument(service, consolidator, document, {topics});
  assert.equal(result.added, 0);
  assert.equal(result.dropped, 1, 'counted with the drops');
  assert.equal(of('capture').length, 0, 'nothing written');
  assert.equal(of('forgotten')[0].statement, 'Do not use em dashes in text.');
  const [action] = result.actions;
  assert.equal(action.did, 'rejected');
  assert.equal(action.on, 'm7', 'the run names the forgotten row');
  assert.match(action.why, /forgot this claim on 2026-09-27/);
  assert.match(action.why, /restore it from the archive/);
  assert.equal(of('marked').length, 1, 'the document is still marked read');
});

test('a live twin wins over a forgotten one, and a replace cannot bring a forgotten claim back', async () => {
  // The em-dash rule was forgotten on 27 September and written again on
  // 6 October, before the forgotten check existed. Both rows exist now. The
  // next time the person says it, the live row is what they mean, so it is
  // affirmed; refusing it for the ghost beside it would freeze its count.
  const {service, consolidator, of} = fake({changes: [
    {action: 'add', statement: 'Do not use em dashes in text.', source: 'no em dashes please',
     kind: 'preference', topic: null, why: 'said again'}]});
  service.nearest = async () => ({id: 'm9', topic_id: null, revision: 2, kind: 'preference', statement: 'Do not use em dashes in text, summaries, or communications.', score: 0.9});
  service.forgottenTwin = async () => { throw new Error('the forgotten check must not run when a live twin claims the add'); };
  service.affirmMemory = async () => {};
  consolidator.reconsider = async () => ({action: 'affirm', statement: '', why: 'same rule'});
  const result = await consolidateDocument(service, consolidator, document, {topics});
  assert.equal(result.affirmed, 1);
  assert.equal(result.dropped, 0);
  assert.equal(of('capture').length, 0);

  // A replace writes a new claim as well, and the same door is shut there.
  const viaReplace = fake({changes: [
    {action: 'replace', target: 'm2', revision: 1, statement: 'Em dashes are fine in summaries.', source: 'em dashes are fine in summaries',
     kind: 'preference', topic: null, why: 'changed their mind'}]});
  viaReplace.service.forgottenTwin = async () => ({id: 'm7', topic_id: null, statement: 'Em dashes are fine.', ended_at: '2026-10-01T10:00:00Z', score: 0.9});
  const replaced = await consolidateDocument(viaReplace.service, viaReplace.consolidator, document, {topics});
  assert.equal(replaced.replaced, 0);
  assert.equal(replaced.dropped, 1);
  assert.equal(viaReplace.of('capture').length, 0, 'nothing written');
  assert.equal(viaReplace.of('end').length, 0, 'the old row is left as it was');
  assert.equal(replaced.actions[0].did, 'rejected');
});

test('a forgotten claim in another topic does not stop the add, and a failed lookup lets it through', async () => {
  const across = fake({changes: [
    {action: 'add', statement: 'Deploys go through the shared pipeline.', source: 'deploy through the shared pipeline',
     kind: 'fact', topic: 'ledger', why: 'a rule'}]});
  across.service.forgottenTwin = async () => ({id: 'm6', topic_id: 'p2', statement: 'Deploys go through the shared pipeline.', score: 0.99});
  const other = await consolidateDocument(across.service, across.consolidator, document, {topics});
  assert.equal(other.added, 1, 'a forget in one topic says nothing about another');

  const broken = fake({changes: [
    {action: 'add', statement: 'Something new.', source: 'something new', kind: 'fact', topic: null, why: 'new'}]});
  broken.service.forgottenTwin = async () => { throw new Error('timeout'); };
  const result = await consolidateDocument(broken.service, broken.consolidator, document, {topics});
  assert.equal(result.added, 1, 'a lookup that fails is the old behaviour, not a refusal');
});

test('a topic the model named is made once, and its memory goes into it', async () => {
  const {service, consolidator, of} = fake({changes: [
    {action: 'add', statement: 'Base images come from the infra-images repository.', source: 's', kind: 'fact',
      topic: 'infrastructure', expires: null, why: 'w'}]});
  const made = [];
  service.upsertTopic = async args => { made.push(args); return {topic: {id: args.topic_id, slug: args.slug}}; };
  const list = [...topics];
  consolidator.consolidate = async input => ({changes: [{action: 'add', statement: 'Base images come from infra-images.',
    source: 's', kind: 'fact', topic: 'infrastructure', expires: null, why: 'w'}],
    dropped: [], named: [{slug: 'infrastructure', brief: 'How the infra is set up'}], prompt: 'p', raw: '{}',
    seen: input.topicsAllowed});
  const result = await consolidateDocument(service, consolidator, document, {topics: list, topicsAllowed: true});
  assert.equal(made.length, 1);
  assert.equal(made[0].slug, 'infrastructure');
  assert.equal(of('capture')[0].topic, 'infrastructure');
  assert.equal(result.topics, 1);
  assert.ok(list.some(p => p.slug === 'infrastructure'), 'the rest of the batch sees the new topic');
  assert.equal(result.actions[0].did, 'made topic');
});

test('a topic that could not be made leaves its memory in personal, as before topics', async () => {
  const {service, consolidator, of} = fake();
  service.upsertTopic = async () => { throw new Error('Topic write unavailable'); };
  consolidator.consolidate = async () => ({changes: [{action: 'add', statement: 'A fact.', source: 's', kind: 'fact',
    topic: 'infrastructure', expires: null, why: 'w'}], dropped: [],
    named: [{slug: 'infrastructure', brief: 'Infra'}], prompt: 'p', raw: '{}'});
  const result = await consolidateDocument(service, consolidator, document, {topics: [...topics], topicsAllowed: true});
  assert.equal(of('capture')[0].topic, null);
  assert.equal(result.topics, 0);
});

test('the pass only makes topics on a connection that sees every topic and may write', async () => {
  for (const [status, allowed] of [[{all_topics: true, can_write: true}, true],
    [{all_topics: false, can_write: true}, false], [{all_topics: true, can_write: false}, false]]) {
    const {service, consolidator, of} = fake();
    service.status = async () => status;
    service.upsertTopic = async () => ({});
    await consolidatePending(service, consolidator);
    assert.equal(of('consolidate')[0].input.topicsAllowed, allowed);
  }
});

test('an unlinked repository is linked to the one topic its session filed into, a new one included', async () => {
  const {service, consolidator} = fake();
  const writes = [];
  service.upsertTopic = async args => {
    writes.push(args);
    return {topic: {id: args.topic_id, slug: args.slug, name: args.name, revision: (args.expected_revision ?? 0) + 1}};
  };
  consolidator.consolidate = async () => ({changes: [
    {action: 'add', statement: 'API tests run against QA nightly.', source: 's', kind: 'fact', topic: 'api-tests', expires: null, why: 'w'},
    {action: 'add', statement: 'Failing API tests block the release.', source: 's', kind: 'fact', topic: 'api-tests', expires: null, why: 'w'},
    {action: 'add', statement: 'Wants short replies.', source: 's', kind: 'preference', topic: null, expires: null, why: 'w'}],
    dropped: [], named: [{slug: 'api-tests', brief: 'The API automation test suite'}], prompt: 'p', raw: '{}'});
  const doc = {...document, topic_id: null, repository: 'acme/api-automation'};
  const result = await consolidateDocument(service, consolidator, doc, {topics: [...topics], topicsAllowed: true});
  const link = writes.find(w => w.repository_change.kind === 'link');
  assert.ok(link, 'the new topic is linked');
  assert.equal(link.repository_change.repository, 'acme/api-automation');
  assert.equal(link.slug, 'api-tests');
  assert.equal(link.expected_revision, 1, 'linked as an update of the topic just made');
  assert.ok(result.actions.some(a => a.did === 'linked repository' && a.statement === 'acme/api-automation'));
});

test('a repository is never linked to a topic the session did not make, or on thin or split evidence', async () => {
  const cases = [
    {name: 'already linked', topics: [{...topics[0], revision: 4, topic_repositories: [{provider: 'github', repository: 'acme/api-automation'}]}, {...topics[1], revision: 2}],
      changes: [{topic: topics[1].slug}], allowed: true},
    {name: 'two topics', topics: topics.map(p => ({...p, revision: 1})),
      changes: [{topic: topics[0].slug}, {topic: topics[1].slug}], allowed: true},
    {name: 'not allowed', topics: topics.map(p => ({...p, revision: 1})), changes: [{topic: topics[0].slug}], allowed: false},
    {name: 'personal only', topics: topics.map(p => ({...p, revision: 1})), changes: [{topic: null}], allowed: true},
    // The production case: a session in an unclaimed repository talking about an existing project.
    {name: 'existing topic', topics: topics.map(p => ({...p, revision: 1})),
      changes: [{topic: topics[0].slug}, {topic: topics[0].slug}], allowed: true},
    {name: 'one change', topics: topics.map(p => ({...p, revision: 1})), changes: [{topic: 'api-tests'}],
      named: [{slug: 'api-tests', brief: 'API tests'}], allowed: true},
  ];
  for (const c of cases) {
    const {service, consolidator} = fake();
    const writes = [];
    service.upsertTopic = async args => { writes.push(args); return {topic: {id: args.topic_id}}; };
    consolidator.consolidate = async () => ({changes: c.changes.map((x, i) => ({action: 'add', statement: `Fact ${i}.`,
      source: 's', kind: 'fact', topic: x.topic, expires: null, why: 'w'})), dropped: [], named: c.named ?? [], prompt: 'p', raw: '{}'});
    await consolidateDocument(service, consolidator, {...document, topic_id: null, repository: 'acme/api-automation'},
      {topics: c.topics, topicsAllowed: c.allowed});
    assert.equal(writes.filter(w => w.repository_change?.kind === 'link').length, 0, c.name);
  }
});

test('the link uses the current revision of the topic, not the stale one the create returned', async () => {
  const {service, consolidator} = fake();
  const writes = [];
  // As production: the create returns revision 1, then stamps made_by and the slug, which bump it to 3.
  service.createSatchelTopic = async args => ({topic: {id: args.topic_id, name: args.name, revision: 1}});
  service.topics = async () => [...topics, {id: made?.id, slug: 'api-tests', name: 'Api Tests', brief: 'API tests', revision: 3}];
  let made = null;
  const create = service.createSatchelTopic;
  service.createSatchelTopic = async args => { made = {id: args.topic_id}; return create(args); };
  service.upsertTopic = async args => { writes.push(args); return {topic: {id: args.topic_id, revision: args.expected_revision + 1}}; };
  consolidator.consolidate = async () => ({changes: ['One.', 'Two.'].map(statement => ({action: 'add', statement,
    source: 's', kind: 'fact', topic: 'api-tests', expires: null, why: 'w'})), dropped: [],
    named: [{slug: 'api-tests', brief: 'API tests'}], prompt: 'p', raw: '{}'});
  await consolidateDocument(service, consolidator, {...document, topic_id: null, repository: 'acme/api-automation'},
    {topics: [...topics], topicsAllowed: true});
  const [link] = writes.filter(w => w.repository_change.kind === 'link');
  assert.equal(link.expected_revision, 3);
});

test('only new rows count towards a link: an extend filed under the new topic does not', async () => {
  const {service, consolidator} = fake();
  const writes = [];
  service.upsertTopic = async args => { writes.push(args); return {topic: {id: args.topic_id, name: args.name, revision: 1}}; };
  consolidator.consolidate = async () => ({changes: [
    {action: 'add', statement: 'API tests run nightly.', source: 's', kind: 'fact', topic: 'api-tests', expires: null, why: 'w'},
    {action: 'extend', target: 'm1', revision: 2, statement: 'Entries are append only, checked nightly.', source: 's',
      kind: 'fact', topic: 'api-tests', why: 'w'}],
    dropped: [], named: [{slug: 'api-tests', brief: 'API tests'}], prompt: 'p', raw: '{}'});
  await consolidateDocument(service, consolidator, {...document, topic_id: null, repository: 'acme/api-automation'},
    {topics: topics.map(p => ({...p, revision: 1})), topicsAllowed: true});
  assert.equal(writes.filter(w => w.repository_change?.kind === 'link').length, 0);
});
