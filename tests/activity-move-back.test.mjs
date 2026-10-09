// Undoing one move from the activity feed: it puts the memory back only while
// it is still where that move left it, and says why when it cannot.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {moveBack} from '../src/features/activity/moveBack.ts';

const topics = [{id: 't-infra', slug: 'infrastructure'}, {id: 't-work', slug: 'work'}];
function fakeDb({memory}) {
  const calls = [];
  const query = data => {
    const chain = {select: () => chain, eq: () => chain, limit: () => chain, order: () => chain,
      abortSignal: async () => ({data, error: null})};
    return chain;
  };
  return {calls, db: {
    from: table => query(table === 'memories' ? (memory ? [memory] : []) : topics),
    rpc: (name, args) => ({abortSignal: async () => { calls.push({name, args}); return {error: null}; }}),
  }};
}
const event = (before, after) => ({id: 'e1', memory_id: 'm1', action: 'moved', before, after, reason: null,
  actor: 'satchel', trace_id: null, document_id: null, created_at: '2026-10-08T20:30:00Z'});

test('a memory still where the move put it goes back, to personal or to a topic', async () => {
  const toPersonal = fakeDb({memory: {id: 'm1', revision: 4, topic_id: 't-infra', ended_at: null}});
  assert.equal(await moveBack(toPersonal.db, event('personal', 'infrastructure')), 'personal');
  assert.deepEqual(toPersonal.calls, [{name: 'move_memory',
    args: {p_id: 'm1', p_revision: 4, p_topic_id: null, p_note: 'moved back by hand'}}]);
  const toTopic = fakeDb({memory: {id: 'm1', revision: 2, topic_id: 't-infra', ended_at: null}});
  await moveBack(toTopic.db, event('work', 'infrastructure'));
  assert.equal(toTopic.calls[0].args.p_topic_id, 't-work');
});

test('a memory that moved again, ended, or came from a topic now gone is left alone, with a reason', async () => {
  const movedOn = fakeDb({memory: {id: 'm1', revision: 5, topic_id: 't-work', ended_at: null}});
  await assert.rejects(moveBack(movedOn.db, event('personal', 'infrastructure')), /moved since, and is in work/);
  const ended = fakeDb({memory: {id: 'm1', revision: 5, topic_id: 't-infra', ended_at: '2026-10-09T00:00:00Z'}});
  await assert.rejects(moveBack(ended.db, event('personal', 'infrastructure')), /not live/);
  const gone = fakeDb({memory: {id: 'm1', revision: 5, topic_id: 't-infra', ended_at: null}});
  await assert.rejects(moveBack(gone.db, event('billing', 'infrastructure')), /billing is gone/);
  for (const fake of [movedOn, ended, gone]) assert.deepEqual(fake.calls, []);
});
