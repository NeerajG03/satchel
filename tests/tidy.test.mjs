// The nightly tidy: what it may move and merge, and that it can never stop
// the pass it runs in front of.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateTidy, buildTidyPrompt, TIDY_SCHEMA} from '../server/tidy.mjs';
import {tidyTopics, consolidateStep} from '../server/consolidation.mjs';

const topics = [
  {id: 't1', slug: 'ledger', brief: 'Go payments ledger', made_by: 'person'},
  {id: 't2', slug: 'deploys', brief: 'How releases go out', made_by: 'satchel'},
  {id: 't3', slug: 'release-process', brief: 'Release steps', made_by: 'satchel'},
];
const memories = [
  {id: 'm1', statement: 'Base images come from the internal registry.', kind: 'fact', revision: 2},
  {id: 'm2', statement: 'Keep answers short.', kind: 'preference', revision: 1},
  {id: 'm3', statement: 'Alerts go to the on-call channel.', kind: 'fact', revision: 1},
];

test('a move needs a real memory and a listed topic, or a new one with a line', () => {
  const out = validateTidy({moves: [
    {memory: 1, topic: 'deploys', why: 'release fact'},
    {memory: 9, topic: 'deploys', why: 'x'},
    {memory: 3, topic: 'monitoring', new_topic: null, why: 'x'},
  ], merges: []}, {topics, memories});
  assert.deepEqual(out.moves.map(m => [m.memory.id, m.slug]), [['m1', 'deploys']]);
  assert.equal(out.dropped.length, 2);
  assert.deepEqual(out.named, []);
});

test('a new topic named twice is one topic, and a near spelling reuses a listed one', () => {
  const out = validateTidy({moves: [
    {memory: 1, topic: 'monitoring', new_topic: 'Alerts and dashboards', why: 'a'},
    {memory: 3, topic: 'monitoring', new_topic: 'Alerting', why: 'b'},
  ], merges: []}, {topics, memories});
  assert.deepEqual(out.named, [{slug: 'monitoring', brief: 'Alerts and dashboards'}]);
  const near = validateTidy({moves: [{memory: 1, topic: 'ledger-api', why: 'a'}], merges: []}, {topics, memories});
  assert.equal(near.moves[0].slug, 'ledger');
});

test('only a topic Satchel made is merged away, once, and moves follow the merge', () => {
  const out = validateTidy({moves: [{memory: 1, topic: 'release-process', why: 'a'}], merges: [
    {from: 'ledger', into: 'deploys', why: 'no'},
    {from: 'release-process', into: 'deploys', why: 'same subject'},
    {from: 'release-process', into: 'ledger', why: 'twice'},
  ]}, {topics, memories});
  assert.deepEqual(out.merges.map(m => [m.from.slug, m.into.slug]), [['release-process', 'deploys']]);
  assert.equal(out.moves[0].slug, 'deploys');
  assert.equal(out.dropped.length, 2);
});

test('the prompt marks the topics Satchel made and numbers personal', () => {
  const {prompt} = buildTidyPrompt({topics, memories});
  assert.match(prompt, /deploys  How releases go out  \[made by Satchel\]/);
  assert.match(prompt, /#2  \[preference\]  Keep answers short\./);
  assert.deepEqual(Object.keys(TIDY_SCHEMA.shape).sort(), ['merges', 'moves']);
});

function service({status = {all_topics: true, can_write: true}, failMove = false} = {}) {
  const calls = [];
  return {calls,
    status: async () => status,
    upsertTopic: async () => ({}),
    createSatchelTopic: async args => { calls.push(['create', args.slug]); return {topic: {id: 'new-' + args.slug}}; },
    topics: async () => topics.map(t => ({...t})),
    memoriesInScope: async () => memories,
    moveMemory: async args => { calls.push(['move', args.id, args.topic_id]); if (failMove) throw new Error('Memory changed or unavailable'); return {}; },
    mergeTopic: async args => { calls.push(['merge', args.from, args.into]); return {}; },
  };
}
const tidier = answer => ({tidy: async input => validateTidy(answer, input)});

test('the tidy makes, merges and moves, and says so', async () => {
  const s = service();
  const run = await tidyTopics(s, tidier({moves: [{memory: 3, topic: 'monitoring', new_topic: 'Alerts', why: 'a'},
    {memory: 1, topic: 'deploys', why: 'b'}], merges: [{from: 'release-process', into: 'deploys', why: 'c'}]}));
  assert.deepEqual(s.calls, [['create', 'monitoring'], ['merge', 't3', 't2'], ['move', 'm3', 'new-monitoring'], ['move', 'm1', 't2']]);
  assert.deepEqual([run.topics, run.merged, run.moved], [1, 1, 2]);
});

test('no tidy without a grant to make topics, and a failed write is recorded, not thrown', async () => {
  assert.equal(await tidyTopics(service({status: {all_topics: false, can_write: true}}), tidier({moves: [], merges: []})), null);
  const run = await tidyTopics(service({failMove: true}), tidier({moves: [{memory: 1, topic: 'deploys', why: 'b'}], merges: []}));
  assert.equal(run.moved, 0);
  assert.equal(run.actions[0].did, 'failed');
  const broken = {tidy: async () => { throw new Error('the tidy model did not answer in time'); }};
  assert.ok((await tidyTopics(service(), broken)).failed);
});

test('a job tidies once, before it reads sessions, even when none are waiting', async () => {
  const s = service();
  let state = null;
  Object.assign(s, {
    reembedMissing: async () => {}, expireRunLogs: async () => {}, pendingDocuments: async () => [],
    settings: async () => ({block_size: 30}),
    moveConsolidationJob: async (id, step, patch) => (state = {...(state ?? job), ...patch}),
  });
  const job = {id: 'j1', step: 1, runs: [], read: 0, failed: 0, idle_minutes: 30,
    deadline_at: new Date(Date.now() + 60_000).toISOString()};
  const out = await consolidateStep(s, {model: 'm'}, job,
    {tidier: tidier({moves: [{memory: 1, topic: 'deploys', why: 'b'}], merges: []})});
  assert.equal(out.job.runs[0].document, 'tidy');
  assert.equal(out.job.status, 'finished');
  state = null;
  const again = await consolidateStep(s, {model: 'm'}, {...job, runs: out.job.runs}, {tidier: {tidy: async () => assert.fail('ran twice')}});
  assert.equal(again.job.status, 'finished');
});
