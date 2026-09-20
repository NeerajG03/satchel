import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEmbedder, EmbeddingError, EMBEDDING_DIMENSIONS, indexedText, toVectorLiteral} from '../server/embedding.mjs';

const vector = (fill = 1) => Array.from({length: EMBEDDING_DIMENSIONS}, () => fill);
const ok = body => async () => ({ok: true, status: 200, json: async () => body});

test('embeddings are normalised, so a stored vector means the same as a query vector', async () => {
  const embedder = createEmbedder({fetchImpl: ok({embeddings: [vector(3)]})});
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
  const embedder = createEmbedder({fetchImpl: async (_url, init) => {
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
  const embedder = createEmbedder({fetchImpl: ok({embeddings: [[1, 2, 3]]})});
  await assert.rejects(embedder.embed(['anything']), EmbeddingError);
});

test('a zero vector is refused, because it would rank against everything equally', async () => {
  const embedder = createEmbedder({fetchImpl: ok({embeddings: [vector(0)]})});
  await assert.rejects(embedder.embed(['anything']), /zero vector/);
});

test('a non-finite value is refused', async () => {
  const bad = vector(1); bad[5] = NaN;
  const embedder = createEmbedder({fetchImpl: ok({embeddings: [bad]})});
  await assert.rejects(embedder.embed(['anything']), /non-finite/);
});

test('a short batch is a failure, never a silent hole', async () => {
  const embedder = createEmbedder({fetchImpl: ok({embeddings: [vector(1)]})});
  await assert.rejects(embedder.embed(['one', 'two']), /2 inputs/);
});

test('a timeout and an error status both surface as EmbeddingError', async () => {
  const slow = createEmbedder({timeoutMs: 5, fetchImpl: () => Promise.reject(new Error('aborted'))});
  await assert.rejects(slow.embed(['anything']), EmbeddingError);
  const failing = createEmbedder({fetchImpl: async () => ({ok: false, status: 503, json: async () => ({})})});
  await assert.rejects(failing.embed(['anything']), /503/);
});

test('empty text is refused before a request is made', async () => {
  let called = false;
  const embedder = createEmbedder({fetchImpl: async () => { called = true; return ok({})(); }});
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
