import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scoreSession, summarise, applyMatches} from '../eval/lib/real-scoring.mjs';

const gold = [
  {statement: 'Use subagents for data heavy exploration.', topic: 'personal', keywords: ['subagent', 'explor'], confidence: 'clear'},
  {statement: 'Only the owning service touches the entity.', topic: 'backend', keywords: ['entit', 'own'], confidence: 'arguable'},
];

test('a memory is found by its keywords as stems, and the topic has to agree', () => {
  const out = scoreSession(gold, [
    {action: 'add', topic: null, statement: 'Use a subagent when the exploration is data heavy.'},
    {action: 'add', topic: null, statement: 'An entity is used only in the service that owns it.'},
  ]);
  assert.deepEqual(out.rows.map(r => [r.found, r.topic]), [[true, true], [true, false]]);
  assert.equal(out.extra.length, 0);
});

test('a claim that matches nothing is listed as extra, and an affirm is not a claim', () => {
  const out = scoreSession(gold, [
    {action: 'add', topic: null, statement: 'Wants tea at four.'},
    {action: 'affirm', topic: null, statement: ''},
  ]);
  assert.equal(out.extra.length, 1);
  assert.deepEqual(out.rows.map(r => r.found), [false, false]);
});

test('one change cannot find two memories, and quiet sessions are counted', () => {
  const one = [{action: 'add', topic: null, statement: 'subagent exploration entity owner'}];
  const out = scoreSession(gold, one);
  assert.equal(out.rows.filter(r => r.found).length, 1);
  const sum = summarise([out, scoreSession([], [{action: 'add', topic: null, statement: 'noise'}]), scoreSession([], [])]);
  assert.deepEqual(sum.quiet, {noisy: 1, total: 2});
  assert.deepEqual(sum.clear, {found: 1, total: 1});
});

test('a judge can rescue a memory the keywords missed, once per claim', () => {
  const first = scoreSession(gold, [{action: 'add', topic: null, statement: 'Wants tea at four.'}]);
  const out = applyMatches(first, [{gold: 0, claim: 0}, {gold: 1, claim: 0}]);
  assert.deepEqual(out.rows.map(r => r.found), [true, false]);
  assert.equal(out.extra.length, 0);
  assert.equal(out.rows[0].judged, true);
});
