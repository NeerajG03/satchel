import test from 'node:test';
import assert from 'node:assert/strict';
import { count, stateWord, whenText, actorLabel, shortWhen } from '../src/app/format.ts';

test('count picks singular and plural', () => {
  assert.equal(count(1, 'task'), '1 task');
  assert.equal(count(3, 'task'), '3 tasks');
  assert.equal(count(2, 'memory', 'memories'), '2 memories');
});

test('stateWord capitalises and drops the underscore', () => {
  assert.equal(stateWord('in_progress'), 'In progress');
  assert.equal(stateWord('blocked'), 'Blocked');
});

test('whenText is relative for recent times', () => {
  const now = Date.parse('2026-09-17T10:00:00Z');
  assert.equal(whenText(new Date(now - 10_000).toISOString(), now), 'just now');
  assert.equal(whenText(new Date(now - 5 * 60_000).toISOString(), now), '5 min ago');
  assert.match(whenText(new Date(now - 3 * 3_600_000).toISOString(), now), /^today /);
});

test('actorLabel resolves users and known agents', () => {
  assert.equal(actorLabel('user:abc'), 'you');
  assert.equal(actorLabel('agent:c1', [{ client_id: 'c1', label: 'Claude Code' }]), 'Claude Code');
  assert.equal(actorLabel('agent:zz', []), 'zz');
});

test('shortWhen fits a narrow column', () => {
  const now = new Date(2026, 9, 20, 15, 0).getTime();
  assert.equal(shortWhen(new Date(now - 20_000).toISOString(), now), '1 min');
  assert.equal(shortWhen(new Date(now - 2 * 3_600_000).toISOString(), now), '2 h');
  assert.doesNotMatch(shortWhen(new Date(now - 20 * 86_400_000).toISOString(), now), /min| h$/);
});
