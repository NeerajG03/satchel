import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEmbedder, EmbeddingError, EMBEDDING_DIMENSIONS, indexedText, toVectorLiteral} from '../server/embedding.mjs';

const vector = (fill = 1) => Array.from({length: EMBEDDING_DIMENSIONS}, () => fill);
const ok = body => async () => ({ok: true, status: 200, json: async () => body});

test('embeddings are normalised, so a stored vector means the same as a query vector', async () => {
  const embedder = createEmbedder({provider: 'ollama', fetchImpl: ok({embeddings: [vector(3)]})});
  const [result] = await embedder.embed(['anything']);
  const length = Math.hypot(...result);
  assert.ok(Math.abs(length - 1) < 1e-9, `expected unit length, got ${length}`);
});

test('the openai shape is read from its own envelope', async () => {
  const embedder = createEmbedder({provider: 'openai', fetchImpl: ok({data: [{embedding: vector(2)}]})});
  const [result] = await embedder.embed(['anything']);
  assert.equal(result.length, EMBEDDING_DIMENSIONS);
});

test('order is preserved across batch boundaries', async () => {
  let call = 0;
  const embedder = createEmbedder({provider: 'ollama', fetchImpl: async (_url, init) => {
    const {input} = JSON.parse(init.body);
    call++;
    return {ok: true, status: 200, json: async () => ({embeddings: input.map((_, i) => {
      const v = vector(0); v[0] = 1; v[1] = (call - 1) * 64 + i; return v;
    })})};
  }});
  const texts = Array.from({length: 150}, (_, i) => `text ${i}`);
  const out = await embedder.embed(texts);
  assert.equal(out.length, 150);
  assert.ok(call > 1, 'more than one batch should have been sent');
  // second component encodes position, and normalisation preserves its ordering
  for (let i = 1; i < out.length; i++) assert.ok(out[i][1] >= out[i - 1][1], `position ${i} out of order`);
});

test('a wrong dimension count is refused rather than stored', async () => {
  const embedder = createEmbedder({provider: 'ollama', fetchImpl: ok({embeddings: [[1, 2, 3]]})});
  await assert.rejects(embedder.embed(['anything']), EmbeddingError);
});

test('a zero vector is refused, because it would rank against everything equally', async () => {
  const embedder = createEmbedder({provider: 'ollama', fetchImpl: ok({embeddings: [vector(0)]})});
  await assert.rejects(embedder.embed(['anything']), /zero vector/);
});

test('a non-finite value is refused', async () => {
  const bad = vector(1); bad[5] = NaN;
  const embedder = createEmbedder({provider: 'ollama', fetchImpl: ok({embeddings: [bad]})});
  await assert.rejects(embedder.embed(['anything']), /non-finite/);
});

test('a short batch is a failure, never a silent hole', async () => {
  const embedder = createEmbedder({provider: 'ollama', fetchImpl: ok({embeddings: [vector(1)]})});
  await assert.rejects(embedder.embed(['one', 'two']), /2 inputs/);
});

test('a timeout and an error status both surface as EmbeddingError', async () => {
  const slow = createEmbedder({provider: 'ollama', timeoutMs: 5, fetchImpl: () => Promise.reject(new Error('aborted'))});
  await assert.rejects(slow.embed(['anything']), EmbeddingError);
  const failing = createEmbedder({provider: 'ollama', fetchImpl: async () => ({ok: false, status: 503, json: async () => ({})})});
  await assert.rejects(failing.embed(['anything']), /503/);
});

test('empty text is refused before a request is made', async () => {
  let called = false;
  const embedder = createEmbedder({provider: 'ollama', fetchImpl: async () => { called = true; return ok({})(); }});
  await assert.rejects(embedder.embed(['   ']), /empty/);
  assert.equal(called, false);
});

test('an unknown provider fails at construction, not at the first query', () => {
  assert.throws(() => createEmbedder({provider: 'nope'}), EmbeddingError);
});

test('the indexed text is statement plus source, which measured best', () => {
  assert.equal(indexedText({statement: 'A', source: 'b'}), 'A b');
  assert.equal(indexedText({statement: 'A', source: '   '}), 'A');
  assert.equal(indexedText({statement: 'A'}), 'A');
});

test('a vector literal is the bracketed form Postgres parses', () => {
  assert.equal(toVectorLiteral([1, 2, 3]), '[1,2,3]');
});

test('the hosted provider is the default, because it is the one the deployment has', () => {
  const embedder = createEmbedder({apiKey: 'x'});
  assert.equal(embedder.provider, 'openai');
  assert.equal(embedder.dimensions, EMBEDDING_DIMENSIONS);
});

test('dimensions are requested, so a 2048-dim model still fits the indexed column', async () => {
  let sent;
  const embedder = createEmbedder({
    provider: 'openai', dimensions: 768, apiKey: 'x',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return {ok: true, status: 200, json: async () => ({data: [{embedding: vector(1)}]})};
    },
  });
  await embedder.embed(['anything']);
  assert.equal(sent.dimensions, 768);
});

test('a model that ignores the dimension request is refused, not stored short', async () => {
  const embedder = createEmbedder({provider: 'openai', apiKey: 'x',
    fetchImpl: ok({data: [{embedding: Array.from({length: 2048}, () => 1)}]})});
  await assert.rejects(embedder.embed(['anything']), /2048 dimensions, expected 768/);
});

test('a rate limit is waited out once, then surfaces rather than retrying forever', async () => {
  let calls = 0;
  const embedder = createEmbedder({provider: 'openai', apiKey: 'x', fetchImpl: async () => {
    calls++;
    return {ok: false, status: 429, headers: {get: () => String(Date.now() + 10)}, json: async () => ({})};
  }});
  await assert.rejects(embedder.embed(['anything']), /429/);
  assert.equal(calls, 2, 'one retry, not a loop');
});

test('each provider is asked at its own path', async () => {
  // `path` defaulted to the string '/embeddings', so `path ?? spec.path` never
  // fell back and the per-provider path was unreachable: ollama posted to
  // /embeddings and got a 404. Every ollama test stubs fetch and none looked
  // at the URL, so nothing noticed.
  const asked = [];
  const record = url => { asked.push(url); return ok({embeddings: [vector(1)], data: [{index: 0, embedding: vector(1)}]})(); };
  await createEmbedder({provider: 'ollama', url: 'http://localhost:11434', fetchImpl: record}).embed(['x']);
  await createEmbedder({provider: 'openai', url: 'https://host/v1', fetchImpl: record}).embed(['x']);
  await createEmbedder({provider: 'openai', url: 'https://host', path: '/custom', fetchImpl: record}).embed(['x']);
  assert.deepEqual(asked, ['http://localhost:11434/api/embed', 'https://host/v1/embeddings', 'https://host/custom']);
});

test('an out-of-order response is put back in order, not mismatched', async () => {
  // The envelope carries an explicit index because the order is not promised,
  // and embed() promises to preserve it: the backfill writes vectors[i] onto
  // rows[i], so a reordered response stores each memory's vector on a
  // different memory, with every row still holding a valid unit vector.
  const mark = n => { const v = vector(0); v[0] = 1; v[1] = n; return v; };
  const embedder = createEmbedder({provider: 'openai', fetchImpl: ok({data: [
    {index: 2, embedding: mark(2)}, {index: 0, embedding: mark(0)}, {index: 1, embedding: mark(1)},
  ]})});
  const out = await embedder.embed(['first', 'second', 'third']);
  for (let i = 1; i < out.length; i++)
    assert.ok(out[i][1] > out[i - 1][1], `position ${i} came back out of order`);
});
