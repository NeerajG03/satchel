import {test} from 'node:test';
import assert from 'node:assert/strict';
import {genAiToLangfuse} from '../server/tracing.mjs';
import {LangfuseOtelSpanAttributes as LF} from '@langfuse/core';

// Read off a real generateObject call, not written from the spec: the AI SDK
// puts the rules in gen_ai.system_instructions and leaves only what came after
// them in gen_ai.input.messages.
const span = extra => ({attributes: {
  'gen_ai.request.model': 'gemini-3.5-flash-lite',
  'gen_ai.input.messages': JSON.stringify([{role: 'user', parts: [{type: 'text', content: 'the turn'}]}]),
  ...extra,
}});
const bridged = attributes => {
  const s = span(attributes);
  genAiToLangfuse({onEnd() {}}).onEnd(s);
  return s.attributes;
};

test('the rules the model was given are on the observation, not only the messages', () => {
  // Without this the trace showed the conversation and not the instructions,
  // so reading a capture meant guessing the wording from the repository, and
  // after a prompt change the guess was wrong.
  const input = JSON.parse(bridged({
    'gen_ai.system_instructions': JSON.stringify([{type: 'text', content: 'THE RULES'}]),
  })[LF.OBSERVATION_INPUT]);
  assert.equal(input[0].role, 'system');
  assert.equal(input[0].parts[0].content, 'THE RULES');
  assert.equal(input[1].parts[0].content, 'the turn', 'and the turn still follows them');
});

test('a call with no system prompt is left exactly as it was', () => {
  assert.deepEqual(JSON.parse(bridged({})[LF.OBSERVATION_INPUT]),
    [{role: 'user', parts: [{type: 'text', content: 'the turn'}]}]);
});

test('instructions that will not parse cost the shape, never the messages', () => {
  // The messages on their own are worth more than a tidy envelope.
  assert.match(bridged({'gen_ai.system_instructions': 'not json'})[LF.OBSERVATION_INPUT],
    /the turn/);
});
