import {test} from 'node:test';
import assert from 'node:assert/strict';
import {search, personal, replayService} from '../eval/lib/injection-twin.mjs';
import {scoreMoment, summarise, pair, gate} from '../eval/lib/injection-scoring.mjs';
import {sessionStart, retrieve} from '../server/lifecycle.mjs';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';
const T1 = '10000000-0000-4000-8000-000000000001';
const T2 = '10000000-0000-4000-8000-000000000002';
const at = '2026-10-11T00:00:00.000Z';

const unit = (x, y) => { const n = Math.hypot(x, y); return [x / n, y / n]; };
const memories = [
  {id: A, topic_id: null, statement: 'personal rule', band: 'said', kind: 'preference', mentions: 2, created_at: '2026-10-01'},
  {id: B, topic_id: T1, statement: 'topic one fact', band: 'said', kind: 'fact', mentions: 1, created_at: '2026-10-01'},
  {id: C, topic_id: T2, statement: 'topic two fact', band: 'heard', kind: 'fact', mentions: 1, created_at: '2026-10-01'},
  {id: D, topic_id: null, statement: 'ended rule', band: 'said', kind: 'preference', mentions: 5, created_at: '2026-10-01', ended_at: '2026-10-05'},
];
const vectors = {[A]: unit(1, 0), [B]: unit(1, 0.2), [C]: unit(1, 0.25), [D]: unit(1, 0)};

test('the twin gates, boosts the scope, excludes, and counts like search_memories', () => {
  const q = unit(1, 0.2);
  const all = search(memories, vectors, q, {gate: 0.9, at});
  assert.deepEqual(all.map(r => r.id), [B, C, A], 'closest first, the ended row never');
  assert.equal(all[0].in_scope, 3);
  assert.equal(all[0].matched, 3);
  const scoped = search(memories, vectors, unit(1, 0.25), {gate: 0.9, in_scope: T1, boost: 1.1, at});
  assert.equal(scoped[0].id, B, 'the boost lifts the scoped row over a closer unscoped one');
  const excluded = search(memories, vectors, q, {gate: 0.9, exclude: [B], limit: 1, at});
  assert.deepEqual(excluded.map(r => r.id), [C]);
  assert.equal(excluded[0].in_scope, 2, 'an excluded row is not in scope');
  assert.equal(search(memories, vectors, q, {gate: 0.9999, at}).length, 1);
});

test('the twin breaks a tie by id, and sees only what was live at that time', () => {
  const tie = {[A]: unit(1, 0), [B]: unit(1, 0)};
  assert.deepEqual(search(memories.slice(0, 2), tie, unit(1, 0), {gate: 0.5, at}).map(r => r.id), [A, B]);
  const early = search(memories, vectors, unit(1, 0), {gate: 0.5, at: '2026-10-03T00:00:00.000Z'});
  assert.ok(early.some(r => r.id === D), 'a row ended later was still live then');
  assert.equal(search(memories, vectors, unit(1, 0), {gate: 0.5, at: '2026-09-01T00:00:00.000Z'}).length, 0);
});

test('personal rows come back most said first', () => {
  const rows = personal([...memories, {id: C, topic_id: null, mentions: 3, created_at: '2026-10-01'}], at);
  assert.deepEqual(rows.map(r => r.id), [C, A]);
});

const snapshot = {taken_at: at, settings: {per_prompt_matches: 5, gate: 0.9, scope_boost: 1.1,
  session_budget_tokens: 15000, capture: false, block_size: 30, staleness_commits: 25},
  topics: [{id: T1, slug: 'one', name: 'One', brief: 'first'}, {id: T2, slug: 'two', name: 'Two', brief: 'second'}],
  links: [{topic_id: T1, provider: 'github', repository: 'acme/one'},
    {topic_id: T1, provider: 'github', repository: 'acme/both'}, {topic_id: T2, provider: 'github', repository: 'acme/both'}],
  memories};

test('the real hooks run on the stand-in service: one linked topic scopes, two do not', async () => {
  const service = replayService({snapshot, vectors, queryVector: async () => unit(1, 0.2)});
  const start = await sessionStart(service, {sessionKey: 's', repository: 'acme/one'});
  assert.equal(start.active_topic, T1);
  assert.deepEqual(service.log[0].memory_ids.sort(), [A, B].sort(), 'the personal row and the topic row load');
  const both = replayService({snapshot, vectors, queryVector: async () => unit(1, 0.2)});
  const unscoped = await sessionStart(both, {sessionKey: 's', repository: 'acme/both'});
  assert.equal(unscoped.active_topic, null);
  assert.match(unscoped.context, /select_topic/);
});

test('retrieve skips the personal rows session start loaded, and host messages search nothing', async () => {
  const service = replayService({snapshot, vectors, queryVector: async () => unit(1, 0.2)});
  await sessionStart(service, {sessionKey: 's', repository: 'acme/one'});
  const mark = service.log.length;
  await retrieve(service, {sessionKey: 's', prompt: 'tell me about the first topic', repository: 'acme/one'});
  const shown = service.log.slice(mark).flatMap(e => e.memory_ids);
  assert.ok(!shown.includes(A), 'the loaded personal row is not shown again');
  const quiet = service.log.length;
  await retrieve(service, {sessionKey: 's', prompt: '<task-notification>done</task-notification>', repository: 'acme/one'});
  assert.equal(service.log.length, quiet);
});

test('a moment is scored on what was in front of the agent, not on which hook put it there', () => {
  const row = scoreMoment({id: 'm', typed: true, shown: [B, C], before: [A],
    gold: {must: [A, B], helps: [], traps: [C], topic: T1}, active: T1, tokens: 40});
  assert.equal(row.mustReached, 2, 'A from the start block, B from the prompt block');
  assert.equal(row.useful, 1);
  assert.equal(row.harmful, 1);
  assert.equal(row.topicRight, true);
  assert.equal(row.utility, 1 * 0.5 * 0.5);
  const silent = scoreMoment({id: 'q', typed: true, shown: [], gold: {must: [], helps: [], traps: []}});
  assert.equal(silent.utility, 1);
  assert.equal(scoreMoment({id: 'n', typed: true, shown: [A], gold: {must: [], helps: [], traps: []}}).utility, 0);
});

test('the scorecard counts repeats and host messages, and the gate holds the line on harm', () => {
  const card = summarise([
    {id: '1', typed: true, shown: [A], before: [A], gold: {must: [A], helps: [], traps: []}, tokens: 30},
    {id: '2', typed: true, shown: [], before: [], gold: {must: [], helps: [], traps: []}},
    {id: '3', typed: false, shown: [B], before: [], tokens: 50},
  ]);
  assert.equal(card.repeat, 0.5);
  assert.equal(card.hostQuiet, 0);
  assert.equal(card.quiet, 1);
  assert.equal(card.reached, 1);
  assert.equal(card.tokens, 30);
  const {a, b, compared, unmatched} = pair(card.rows, [{id: '1', utility: 0}, {id: '9', utility: 1}]);
  assert.deepEqual([a, b, compared, unmatched], [[1], [0], 1, 1]);
  assert.equal(gate({reached: 0.5, harmful: 0}, {reached: 0.6, harmful: 0}).pass, false);
  assert.equal(gate({reached: 0.6, harmful: 1}, {reached: 0.6, harmful: 0}).pass, false);
  assert.equal(gate({reached: 0.59, harmful: 0}, {reached: 0.6, harmful: 0}, {significant: false, delta: -0.01}).pass, true);
});

test('the twin compares database and transcript timestamps as instants', () => {
  const rows = [{...memories[0], created_at: '2026-10-01 00:00:00+00', ended_at: '2026-10-05 08:00:00.5+00'}];
  assert.equal(search(rows, vectors, unit(1, 0), {gate: 0.5, at: '2026-10-05T06:00:00.000Z'}).length, 1,
    'ended two hours after the moment, so still live then');
  assert.equal(search(rows, vectors, unit(1, 0), {gate: 0.5, at: '2026-10-05T09:00:00.000Z'}).length, 0);
});

test('personal rows with no affirmation sort first, as Postgres sorts nulls in a descending order', () => {
  const rows = personal([
    {id: A, topic_id: null, mentions: 1, affirmed_at: '2026-10-02T00:00:00.000Z', created_at: '2026-10-01'},
    {id: B, topic_id: null, mentions: 1, affirmed_at: null, created_at: '2026-10-01'},
  ], at);
  assert.deepEqual(rows.map(r => r.id), [B, A]);
});

test('retrieve skips the active topic rows session start loaded, and says what it showed', async () => {
  const scoped = {...snapshot, settings: {...snapshot.settings, gate: 0.5}};
  const service = replayService({snapshot: scoped, vectors, queryVector: async () => unit(1, 0.2)});
  await sessionStart(service, {sessionKey: 's', repository: 'acme/one'});
  const out = await retrieve(service, {sessionKey: 's', prompt: 'what about the first topic', repository: 'acme/one'});
  assert.ok(!out.shown.includes(B), 'the topic row loaded at the start is not shown again');
  assert.ok(out.shown.includes(C), 'a row the start block did not load still is');
  const again = await retrieve(service, {sessionKey: 's', prompt: 'and again', repository: 'acme/one', exclude: out.shown});
  assert.deepEqual(again.shown, [], 'what the hook sends back is skipped');
});
