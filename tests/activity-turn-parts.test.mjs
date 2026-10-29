// A kept turn splits into what was said and what the agent did, and only the
// trailing actions block counts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {targetLabel, turnParts, verbLabel} from '../src/features/activity/turnParts.ts';

test('a reply with actions splits into text and steps', () => {
  const parts = turnParts('Done, tests pass.\n\nActions this turn:\n- ran: npm test\n- edited: src/app.ts\n- used: WebFetch');
  assert.equal(parts.text, 'Done, tests pass.');
  assert.deepEqual(parts.actions, [
    {verb: 'ran', target: 'npm test'}, {verb: 'edited', target: 'src/app.ts'}, {verb: 'used', target: 'WebFetch'}]);
});

test('a tool-only turn has no text', () => {
  const parts = turnParts('Actions this turn:\n- read: server/x.mjs');
  assert.equal(parts.text, '');
  assert.deepEqual(parts.actions, [{verb: 'read', target: 'server/x.mjs'}]);
});

test('a target keeps its own colons', () => {
  assert.deepEqual(turnParts('Actions this turn:\n- ran: git log --format=a: b').actions,
    [{verb: 'ran', target: 'git log --format=a: b'}]);
});

test('a reply that only mentions the phrase is left whole', () => {
  for (const text of [
    'I print "Actions this turn:" in the footer.',
    'Actions this turn: are listed below, in prose.',
    'Actions this turn:\n- ran: ls\nand then I stopped.',
    'No actions here',
    '',
  ]) assert.deepEqual(turnParts(text), {text, actions: []});
});

test('only the last block is the actions', () => {
  const parts = turnParts('Actions this turn:\n- ran: a\n\nthen more\n\nActions this turn:\n- ran: b');
  assert.equal(parts.text, 'Actions this turn:\n- ran: a\n\nthen more');
  assert.deepEqual(parts.actions, [{verb: 'ran', target: 'b'}]);
});

test('verbs read as plain words', () => {
  assert.equal(verbLabel('ran'), 'Ran');
  assert.equal(verbLabel('searched'), 'Searched');
  assert.equal(verbLabel('deleted'), 'Deleted');
  assert.equal(verbLabel(''), 'Did');
});

test('a tool from another server reads as the tool, then where it came from', () => {
  assert.equal(targetLabel({verb: 'used', target: 'mcp__ccd_turn__update_plan'}), 'update plan · ccd turn');
  assert.equal(targetLabel({verb: 'used', target: 'mcp__plugin_satchel_satchel__retrieve_memory'}), 'retrieve memory · satchel');
  assert.equal(targetLabel({verb: 'used', target: 'WebFetch'}), 'WebFetch');
  assert.equal(targetLabel({verb: 'ran', target: 'mcp__x__y'}), 'mcp__x__y', 'only a used tool is renamed');
});
