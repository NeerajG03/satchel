import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturePrompt, resetPromptCache, localText, CAPTURE_PROMPT} from '../server/prompt-store.mjs';
import {createRouter, buildPrompt, INSTRUCTIONS} from '../server/router.mjs';

const configured = extra => ({baseUrl: 'https://lf.example', publicKey: 'pk', secretKey: 'sk', ...extra});
const served = (body, status = 200) => async () =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('with no Langfuse configured the committed file is the answer, not an error', async () => {
  resetPromptCache();
  const out = await capturePrompt({baseUrl: null, publicKey: null, secretKey: null});
  assert.equal(out.source, 'local');
  assert.equal(out.text, localText);
  assert.ok(out.text.length > 1000, 'and it is the real prompt, not an empty string');
});

test('a published version is used and named, so a capture can be explained later', async () => {
  resetPromptCache();
  let asked;
  const out = await capturePrompt(configured({
    fetchImpl: async url => { asked = url; return (await served({prompt: 'newer wording', version: 7})()); },
  }));
  assert.equal(out.text, 'newer wording');
  assert.equal(out.version, 7);
  assert.equal(out.source, 'langfuse');
  assert.match(String(asked), new RegExp(`prompts/${CAPTURE_PROMPT}`));
  assert.match(String(asked), /label=production/);
});

test('one fetch per warm instance, not one per turn', async () => {
  resetPromptCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return served({prompt: 'x', version: 1})(); };
  await capturePrompt(configured({fetchImpl}));
  await capturePrompt(configured({fetchImpl}));
  assert.equal(calls, 1);
  // And the cache is a TTL, not a lifetime: a label moved in Langfuse has to
  // reach a long-lived instance without a deploy.
  await capturePrompt(configured({fetchImpl, ttlMs: 0}));
  assert.equal(calls, 2);
});

for (const [why, respond] of [
  ['nothing published yet', served({message: 'not found'}, 404)],
  ['Langfuse is down', served({}, 503)],
  ['the version is empty', served({prompt: '   ', version: 3})],
  ['the body is not a text prompt', served({prompt: [{role: 'system'}], version: 3})],
  ['the request throws', async () => { throw new Error('ECONNRESET'); }],
]) {
  test(`capture still runs when ${why}`, async () => {
    resetPromptCache();
    const out = await capturePrompt(configured({fetchImpl: respond}));
    assert.equal(out.source, 'local', 'the committed file answers');
    assert.equal(out.text, localText);
    assert.equal(out.version, null);
  });
}

test('a failure is cached too, so a repo that never pushed does not pay a request a turn', async () => {
  resetPromptCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return served({}, 404)(); };
  await capturePrompt(configured({fetchImpl}));
  await capturePrompt(configured({fetchImpl}));
  assert.equal(calls, 1);
});

test('buildPrompt uses the committed wording unless it is handed another', () => {
  assert.equal(INSTRUCTIONS, localText, 'the fallback is the file, not a second copy that can drift');
  assert.equal(buildPrompt({turn: ['hi']}).system, localText);
  assert.equal(buildPrompt({turn: ['hi'], instructions: 'something else'}).system, 'something else');
});

test('the router sends whatever the store resolved, not the file it was built with', async () => {
  let sent;
  const router = createRouter({
    apiKey: 'x',
    promptResolver: async () => ({text: 'the published wording', source: 'langfuse', version: 9}),
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({candidates: [{content: {parts: [{text: '{"memories":[]}'}]},
        finishReason: 'STOP'}]}), {headers: {'content-type': 'application/json'}});
    },
  });
  const out = await router.route({turn: ['hello']});
  assert.match(JSON.stringify(sent), /the published wording/);
  assert.equal(out.promptVersion, 9);
  assert.equal(out.promptSource, 'langfuse');
});
