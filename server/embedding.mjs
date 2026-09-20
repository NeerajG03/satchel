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

import {embedding as traceEmbedding} from './tracing.mjs';

export const EMBEDDING_DIMENSIONS = 768;
const MAX_BATCH = 64;
const MAX_CHARS = 8000;

export class EmbeddingError extends Error {
  constructor(message, {cause} = {}) { super(message); this.name = 'EmbeddingError'; this.cause = cause; }
}

function normalize(vector, model, expected) {
  if (!Array.isArray(vector) || vector.length !== expected)
    throw new EmbeddingError(`${model} returned ${vector?.length ?? 'no'} dimensions, expected ${expected}`);
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
  // Any OpenAI-compatible embeddings endpoint. OpenRouter and Google's
  // compatibility layer both speak this, so moving between them is env, not
  // code. Google's differs only in where the path sits under the base URL,
  // which is why `path` is overridable below.
  //
  // `dimensions` matters more than it looks. pgvector indexes vectors up to
  // 2,000 dimensions and several current embedding models return 2,048, so a
  // model that can truncate fits the column the migration already declares and
  // one that cannot needs halfvec and 2.7x the storage.
  openai: {
    // Relative to a base URL that already carries its version segment, which is
    // the convention for all three hosts this is used with:
    // .../v1beta/openai, https://api.openai.com/v1, https://openrouter.ai/api/v1.
    path: '/embeddings',
    body: (model, inputs, dimensions) => ({model, input: inputs, ...(dimensions ? {dimensions} : {})}),
    // Sorted by index, not taken in array order. The envelope carries an
    // explicit index precisely because the order is not promised, and embed()
    // promises to preserve order: the backfill writes vectors[i] onto rows[i],
    // so a reordered response would store each memory's vector on a different
    // memory, with every row still holding a valid unit vector and nothing to
    // show for it but quietly wrong matches.
    read: payload => Array.isArray(payload?.data)
      ? [...payload.data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map(row => row?.embedding)
      : undefined,
  },
};

export function createEmbedder({
  // Gemini by default: it is the only free tier measured to survive real use,
  // and gemini-embedding-001 honours a dimensions request, so 768 fits the
  // indexed column rather than needing halfvec. At 768 it returns an
  // un-normalised vector, which normalize() below already handles; the full
  // 3072 comes back normalised. Any OpenAI-compatible host, including a local
  // ollama, is a change of url, path and model.
  provider = process.env.SATCHEL_EMBEDDING_PROVIDER ?? 'openai',
  model = process.env.SATCHEL_EMBEDDING_MODEL ?? 'gemini-embedding-001',
  url = process.env.SATCHEL_EMBEDDING_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey = process.env.SATCHEL_EMBEDDING_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY,
  dimensions = Number(process.env.SATCHEL_EMBEDDING_DIMENSIONS ?? EMBEDDING_DIMENSIONS),
  path = process.env.SATCHEL_EMBEDDING_PATH,
  timeoutMs = Number(process.env.SATCHEL_EMBEDDING_TIMEOUT_MS ?? 4000),
  fetchImpl = fetch,
} = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new EmbeddingError(`Unknown embedding provider ${provider}`);

  // One observation covers the whole call including the retry. Ending the span
  // on the 429 branch was the bug: it returned into a fresh attempt with
  // tracing disabled, so a rate-limited embedding was never ended and never
  // recorded, losing exactly the traces worth having. Every exit now runs
  // through end() or fail().
  async function batch(inputs) {
    const trace = traceEmbedding('embed', {model, input: inputs, metadata: {dimensions, count: inputs.length}});
    try {
      const payload = await attempt(inputs, true);
      const vectors = spec.read(payload);
      if (!Array.isArray(vectors) || vectors.length !== inputs.length)
        throw new EmbeddingError(`${model} returned ${vectors?.length ?? 0} embeddings for ${inputs.length} inputs`);
      const normalized = vectors.map(vector => normalize(vector, model, dimensions));
      trace.end({vectors: normalized.length, dimensions: normalized[0]?.length ?? 0},
        {usageDetails: payload?.usage ?? undefined});
      return normalized;
    } catch (error) {
      trace.fail(error);
      throw error;
    }
  }

  async function attempt(inputs, retryOn429) {
    let response;
    try {
      response = await fetchImpl(url.replace(/\/+$/, '') + (path ?? spec.path), {
        method: 'POST',
        headers: {'content-type': 'application/json', ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {})},
        body: JSON.stringify(spec.body(model, inputs, dimensions)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new EmbeddingError(`${model} did not respond within ${timeoutMs}ms`, {cause});
    }
    // OpenRouter's free models allow 20 requests a minute per account, shared
    // across every user of this deployment. On the read path that is one
    // retrieval's worth of delay against no retrieval at all, so it is worth a
    // single short wait and no more; the caller still degrades to silence.
    if (response.status === 429 && retryOn429) {
      const reset = Number(response.headers?.get?.('x-ratelimit-reset')) || 0;
      await new Promise(done => setTimeout(done, Math.min(Math.max(reset - Date.now(), 500), 2000)));
      return attempt(inputs, false);
    }
    if (!response.ok) throw new EmbeddingError(`${model} returned ${response.status}`);
    try { return await response.json(); }
    catch (cause) { throw new EmbeddingError(`${model} returned a malformed response`, {cause}); }
  }

  return {
    model, provider, dimensions,
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
