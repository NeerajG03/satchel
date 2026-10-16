import {test} from 'node:test';
import assert from 'node:assert/strict';
import {search, personal, replayService} from '../eval/lib/injection-twin.mjs';
import {scoreMoment, summarise, pair, gate, asOf, aheadNeeds, comparable} from '../eval/lib/injection-scoring.mjs';
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

test('a row from a topic the repository is not linked to needs a closer match than the gate', async () => {
  const scoped = {...snapshot, settings: {...snapshot.settings, gate: 0.5}};
  const loose = {...vectors, [C]: unit(1, 2)};
  const ask = async vecs => {
    const service = replayService({snapshot: scoped, vectors: vecs, queryVector: async () => unit(1, 0.2)});
    return retrieve(service, {sessionKey: 's', prompt: 'what about the first topic', repository: 'acme/one'});
  };
  assert.ok(!(await ask(loose)).shown.includes(C), 'a loose match from the other topic is dropped');
  assert.ok((await ask(vectors)).shown.includes(C), 'a close match from the other topic still gets through');
  const bare = replayService({snapshot: scoped, vectors: loose, queryVector: async () => unit(1, 0.2)});
  const out = await retrieve(bare, {sessionKey: 'b', prompt: 'what about the first topic', repository: 'acme/none'});
  assert.ok(out.shown.includes(C), 'with no link nothing is a stranger');
});

// The as-of replay: each prompt is judged against the memories of its own
// day, and the start block's rows are paid for where they load.

const E = '00000000-0000-4000-8000-00000000000e';
const later = {id: E, topic_id: T1, statement: 'written on the eighth', band: 'said', kind: 'fact', mentions: 1, created_at: '2026-10-08T00:00:00.000Z'};
const dated = {...snapshot, memories: [...memories, later]};
const byId = new Map(dated.memories.map(m => [m.id, m]));

test('the stand-in serves what existed at the moment, not today', async () => {
  const service = replayService({snapshot: dated, vectors: {...vectors, [E]: unit(1, 0.2)}, queryVector: async () => unit(1, 0.2)});
  assert.equal(service.state.at, at, 'left alone it is the snapshot time');
  assert.deepEqual((await service.personal()).map(m => m.id), [A], 'today the ended rule is gone');
  assert.deepEqual((await service.index(T1)).memories.map(m => m.id), [B, E]);
  service.state.at = '2026-10-03T00:00:00.000Z';
  assert.deepEqual((await service.personal()).map(m => m.id), [D, A], 'on the third the rule had not been ended yet');
  assert.deepEqual((await service.index(T1)).memories.map(m => m.id), [B], 'and the eighth\'s row did not exist');
  const found = await service.search({query: 'x', gate: 0.9, limit: 5});
  assert.ok(!found.some(r => r.id === E), 'search is as of the moment too');
  service.state.at = '2026-10-09T00:00:00.000Z';
  assert.ok((await service.search({query: 'x', gate: 0.9, limit: 5})).some(r => r.id === E));
});

test('the twin serves ages from the snapshot, so the labels read as they would in production', async () => {
  const service = replayService({snapshot: dated, vectors: {...vectors, [E]: unit(1, 0.2)}, queryVector: async () => unit(1, 0.2)});
  assert.deepEqual(await service.ages([A, E, 'nobody']), [
    {id: A, created_at: '2026-10-01', mentions: 2}, {id: E, created_at: '2026-10-08T00:00:00.000Z', mentions: 1}]);
  assert.deepEqual(await service.ages([]), []);
  // Through the real hooks: a heard topic row made two days before the prompt
  // is a draft on that day, and nothing of the kind a month later.
  const scoped = {...dated, settings: {...dated.settings, gate: 0.5}};
  const young = replayService({snapshot: scoped, vectors, queryVector: async () => unit(1, 0.25)});
  young.state.at = '2026-10-03T00:00:00.000Z';
  const then = await retrieve(young, {sessionKey: 's', prompt: 'topic two', repository: 'acme/none', now: () => new Date('2026-10-03T00:00:00.000Z')});
  assert.match(then.context, /\(two, picked up\) {2}topic two fact\n {10}\[picked up 2 days ago, said once/);
  const old = replayService({snapshot: scoped, vectors, queryVector: async () => unit(1, 0.25)});
  const later = await retrieve(old, {sessionKey: 's', prompt: 'topic two', repository: 'acme/none', now: () => new Date('2026-11-01T00:00:00.000Z')});
  assert.match(later.context, /\(two, picked up\) {2}topic two fact/);
  assert.doesNotMatch(later.context, /not confirmed since/);
});

test('gold needs that did not exist yet are dropped, and a prompt left with none is unlabelled', () => {
  const ts = '2026-10-03T00:00:00.000Z';
  const g = asOf({must: [B, E], helps: [D], traps: [C], topic: T1}, ts, byId);
  assert.deepEqual(g.must, [B], 'E was written five days after the prompt');
  assert.deepEqual(g.helps, [D], 'D was still live on the third');
  assert.deepEqual(g.traps, [C]);
  assert.equal(g.topic, T1);
  assert.equal(asOf({must: [E], helps: [], traps: []}, ts, byId), null, 'nothing it needed existed yet');
  assert.equal(asOf({must: [], helps: [E], traps: [C]}, ts, byId), null);
  assert.deepEqual(asOf({must: [], helps: [], traps: [C]}, ts, byId), {must: [], helps: [], traps: [C]},
    'a prompt that needed nothing is still a quiet prompt, not left out');
  const ended = asOf({must: [D], helps: [A], traps: []}, '2026-10-06T00:00:00.000Z', byId);
  assert.deepEqual([ended.must, ended.helps, ended.traps], [[], [A], [D]], 'a need ended by then is a trap');
  assert.equal(asOf(null, ts, byId), null);
  const card = summarise([{id: 'u', typed: true, shown: [A], gold: null}, {id: 'q', typed: true, shown: [], gold: {must: [], helps: [], traps: []}}]);
  assert.equal(card.typed, 1, 'the left-out prompt is not scored');
  assert.equal(card.slots, 1, 'but its slots still count');
  assert.equal(card.quiet, 1);
});

test('a block row is charged where it loads, and is useful when a later prompt needs it', () => {
  const session = aheadNeeds([
    {id: 's:1', session: 's', typed: true, shown: [], loaded: [A, B], resetBefore: true, gold: {must: [], helps: [], traps: []}},
    {id: 's:2', session: 's', typed: true, shown: [], loaded: [], gold: {must: [A], helps: [], traps: []}, before: [A, B]},
    {id: 's:3', session: 's', typed: true, shown: [], loaded: [C], resetBefore: true, gold: {must: [], helps: [], traps: []}},
    {id: 's:4', session: 's', typed: true, shown: [], loaded: [], gold: {must: [B], helps: [], traps: []}},
  ]);
  assert.deepEqual(session[0].ahead, [A], 'the first stretch needs A; B is needed only after the compact');
  assert.deepEqual(session[2].ahead, [B], 'the compact starts a new stretch');
  const [first, second, third, fourth] = session.map(scoreMoment);
  assert.equal(first.utilityFree, 1, 'free, a quiet prompt with an empty prompt block is perfect');
  assert.equal(first.utility, 0.5, 'charged, one of the two rows the block loaded was needed in the stretch');
  assert.equal(first.blockRows, 2);
  assert.equal(first.blockUseful, 1);
  assert.equal(second.utility, 1, 'the row was in front of the agent, and this prompt loaded nothing');
  assert.equal(third.utility, 0, 'the row loaded after the compact was needed by nobody');
  assert.equal(fourth.utility, 0, 'B was needed and the compact had taken it out of front');
  const answerable = scoreMoment({id: 'a', typed: true, shown: [B], loaded: [A, C], ahead: [A, B], before: [A, C],
    gold: {must: [A, B], helps: [], traps: []}});
  assert.equal(answerable.utilityFree, 1);
  assert.equal(answerable.utility, 2 / 3, 'two of the three rows in front earned their room');
  const card = summarise(session);
  assert.equal(card.blockRows, 3);
  assert.equal(card.blockUseful, 1 / 3);
  assert.equal(card.utilityFree, 0.75);
  assert.equal(card.utility, 0.375);
});

test('a baseline scored the old way is not compared', () => {
  const here = {snapshot: at, method: 'as-of-1'};
  assert.equal(comparable(null, here).ok, false);
  const old = comparable({snapshot: at, summary: {}}, here);
  assert.equal(old.ok, false);
  assert.match(old.reason, /scored the old way/);
  const other = comparable({snapshot: '2026-10-01T00:00:00.000Z', method: 'as-of-1'}, here);
  assert.match(other.reason, /snapshot, not this one/);
  assert.equal(comparable({snapshot: at, method: 'as-of-1'}, here).ok, true);
});
