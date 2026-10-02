// Which prompts the person typed. Measured over a week of real traffic, more
// than half of prompt-time memory hits went to text the host or another agent
// produced, and every one of those was recorded as the person's own words.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyPrompt, machineTurnNote} from '../server/machine-prompt.mjs';

test('what a person types is theirs, whole', () => {
  const typed = 'can we bump Go before payouts ship? I think not';
  assert.deepEqual(classifyPrompt(typed), {kind: null, query: typed});
  assert.deepEqual(classifyPrompt('yes'), {kind: null, query: 'yes'});
});

test('a subagent report, a task notification and a CI event are not the person', () => {
  const handback = 'Another Claude session sent a message:\n<agent-message from="abc">\n[Subagent hand-back] The text below…';
  assert.equal(classifyPrompt(handback).kind, 'agent message');
  assert.equal(classifyPrompt(handback).query, null);
  assert.equal(classifyPrompt('[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>…').kind, 'task notification');
  assert.equal(classifyPrompt('[SYSTEM NOTIFICATION - NOT USER INPUT]\nsomething else').kind, 'system notification');
  assert.equal(classifyPrompt('<task-notification>\n<task-id>x</task-id>').kind, 'task notification');
  assert.equal(classifyPrompt('<ci-monitor-event>{"status":"failed"}</ci-monitor-event>').kind, 'ci event');
  assert.equal(classifyPrompt('<system-reminder id="1">stale</system-reminder>').kind, 'system reminder');
});

test('a marker deep inside a long prompt does not make it a machine message', () => {
  // The person may paste a log that mentions one. Only the head of the prompt
  // decides, because that is where the host puts its own wrapper.
  const pasted = 'here is what the agent said earlier, is it right?\n' + 'x'.repeat(500) + '\n<task-notification>';
  assert.equal(classifyPrompt(pasted).kind, null);
});

test('a slash command is the person when it carries arguments, and the arguments are the query', () => {
  const withArgs = '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n'
    + '<command-args>get the memory system to 8 out of 10</command-args>';
  assert.deepEqual(classifyPrompt(withArgs), {kind: null, query: 'get the memory system to 8 out of 10'});
  const bare = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
  assert.deepEqual(classifyPrompt(bare), {kind: 'command', query: null});
});

test('the note a machine message leaves in the document names the kind and nothing else', () => {
  assert.equal(machineTurnNote('agent message'), '[host message, not the person: agent message]');
});
