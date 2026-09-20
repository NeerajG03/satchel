// Turns text into the vector search_memories compares against.
//
// Two rules the rest of the system depends on:
//
//   1. Vectors are L2-normalised here, so cosine distance and dot product agree
//      and a stored vector always means the same thing as a query vector.
//   2. A failure throws. It never returns a zero vector or a partial batch,
//      because a plausible-looking wrong vector is worse than no retrieval:
//      retrieval degrading to silence is a design position, silently ranking
//      against noise is a bug.
//
// The model name travels with every embedding it produces. Changing models
// means re-embedding, and pairing them in the schema is what makes that
// detectable instead of silent.

export const EMBEDDING_DIMENSIONS = 768;
const MAX_BATCH = 64;
const MAX_CHARS = 8000;

export class EmbeddingError extends Error {
  constructor(message, {cause} = {}) { super(message); this.name = 'EmbeddingError'; this.cause = cause; }
}

function normalize(vector, model) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS)
    throw new EmbeddingError(`${model} returned ${vector?.length ?? 'no'} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
  let sum = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new EmbeddingError(`${model} returned a non-finite value`);
    sum += value * value;
  }
  const length = Math.sqrt(sum);
  if (!length) throw new EmbeddingError(`${model} returned a zero vector`);
  return vector.map(value => value / length);
}

const PROVIDERS = {
  // Local ollama. Nothing leaves the machine, which is the only shape that
  // keeps the read path free of a network hop and of a privacy question.
  ollama: {
    path: '/api/embed',
    body: (model, inputs) => ({model, input: inputs}),
    read: payload => payload?.embeddings,
  },
  // Any OpenAI-compatible embeddings endpoint.
  openai: {
    path: '/v1/embeddings',
    body: (model, inputs) => ({model, input: inputs}),
    read: payload => payload?.data?.map(row => row?.embedding),
  },
};

export function createEmbedder({
  provider = process.env.SATCHEL_EMBEDDING_PROVIDER ?? 'ollama',
  model = process.env.SATCHEL_EMBEDDING_MODEL ?? 'nomic-embed-text',
  url = process.env.SATCHEL_EMBEDDING_URL ?? 'http://127.0.0.1:11434',
  apiKey = process.env.SATCHEL_EMBEDDING_KEY,
  timeoutMs = Number(process.env.SATCHEL_EMBEDDING_TIMEOUT_MS ?? 2000),
  fetchImpl = fetch,
} = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new EmbeddingError(`Unknown embedding provider ${provider}`);

  async function batch(inputs) {
    let response;
    try {
      response = await fetchImpl(url.replace(/\/+$/, '') + spec.path, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {})},
        body: JSON.stringify(spec.body(model, inputs)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) { throw new EmbeddingError(`${model} did not respond within ${timeoutMs}ms`, {cause}); }
    if (!response.ok) throw new EmbeddingError(`${model} returned ${response.status}`);
    let payload;
    try { payload = await response.json(); }
    catch (cause) { throw new EmbeddingError(`${model} returned a malformed response`, {cause}); }
    const vectors = spec.read(payload);
    if (!Array.isArray(vectors) || vectors.length !== inputs.length)
      throw new EmbeddingError(`${model} returned ${vectors?.length ?? 0} embeddings for ${inputs.length} inputs`);
    return vectors.map(vector => normalize(vector, model));
  }

  return {
    model, provider, dimensions: EMBEDDING_DIMENSIONS,
    /** Embeds many texts, preserving order. Throws rather than returning a hole. */
    async embed(texts) {
      const inputs = texts.map(text => {
        if (typeof text !== 'string' || !text.trim()) throw new EmbeddingError('Cannot embed empty text');
        return text.slice(0, MAX_CHARS);
      });
      const out = [];
      for (let i = 0; i < inputs.length; i += MAX_BATCH) out.push(...await batch(inputs.slice(i, i + MAX_BATCH)));
      return out;
    },
    async embedOne(text) { return (await this.embed([text]))[0]; },
  };
}

/** What gets indexed. Measured: statement plus source beats statement alone,
 *  and prefixing the project name is worse than either. See
 *  docs/memory-v2-build.md section 4.10. */
export const indexedText = memory =>
  memory.source?.trim() ? `${memory.statement} ${memory.source}` : memory.statement;

/** Postgres accepts a vector literal as a bracketed list of numbers. */
export const toVectorLiteral = vector => `[${vector.join(',')}]`;
