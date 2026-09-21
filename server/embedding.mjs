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
//
// The HTTP call is the AI SDK's now, not ours. What stays ours is everything
// above: normalisation, the dimension guard, the retry policy and the fallback
// route. Those are not plumbing, they are the guarantees.

import {embed as sdkEmbed, embedMany, APICallError} from 'ai';
import {readApiFailure} from './rate-limit.mjs';
import {providerFor, asBaseUrl, describeFailure} from './model-provider.mjs';

export const EMBEDDING_DIMENSIONS = 768;
const MAX_CHARS = 8000;

export class EmbeddingError extends Error {
  constructor(message, {cause, code, reason, retryAfterMs} = {}) {
    super(message);
    this.name = 'EmbeddingError';
    this.cause = cause;
    // `code` and `reason` are what the lifecycle hook turns into the line the
    // person reads. Without them every failure in this file arrived as
    // "Satchel request failed. Reload before retrying a write: it may have
    // completed", which is unhelpful and also untrue: nothing was written.
    if (code) this.code = code;
    if (reason) this.reason = reason;
    if (retryAfterMs) this.retryAfterMs = retryAfterMs;
  }
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

const sleep = ms => new Promise(done => setTimeout(done, ms));

// What a piece of text is for. gemini-embedding-001 is an asymmetric retrieval
// model: a stored memory and the prompt looking for it are supposed to be
// embedded differently, and the OpenAI compatibility layer we used before had
// no field to say so, so we have never once used it.
//
// It is off by default and that is deliberate. Turning it on changes the
// embedding space, so every vector already stored would be compared against
// query vectors from a different space: retrieval would get quietly worse with
// nothing failing. Opting in therefore changes the recorded model name too, so
// embedding_model still tells the two spaces apart and the backfill knows the
// corpus needs re-embedding. Measure it with the eval before switching it on.
export const TASK_TYPES = {document: 'RETRIEVAL_DOCUMENT', query: 'RETRIEVAL_QUERY'};

export function createEmbedder({
  // Google natively by default rather than through its OpenAI compatibility
  // layer, because taskType only exists on the native API. Any OpenAI-shaped
  // host, including OpenRouter, OpenAI itself and a local ollama on its /v1
  // endpoint, is `openai` plus a url.
  provider = process.env.SATCHEL_EMBEDDING_PROVIDER ?? 'google',
  // gemini-embedding-001 is the measured one: published MTEB, a taskType, and
  // cheaper than gemini-embedding-2 at $0.15 against $0.20 per million tokens.
  // It honours a dimensions request, so 768 fits the indexed column rather than
  // needing halfvec. At 768 it returns an un-normalised vector, which
  // normalize() handles; the full 3072 comes back normalised.
  model = process.env.SATCHEL_EMBEDDING_MODEL ?? 'gemini-embedding-001',
  baseURL = asBaseUrl(process.env.SATCHEL_EMBEDDING_URL),
  apiKey = process.env.SATCHEL_EMBEDDING_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY,
  dimensions = Number(process.env.SATCHEL_EMBEDDING_DIMENSIONS ?? EMBEDDING_DIMENSIONS),
  timeoutMs = Number(process.env.SATCHEL_EMBEDDING_TIMEOUT_MS ?? 4000),
  // Unset means "no taskType", which is the space every stored vector is in.
  taskType = process.env.SATCHEL_EMBEDDING_TASK_TYPE,
  // A second route for the SAME model, on a different key. Gemini's free
  // embedding quota is per project per model, so a second project doubles it,
  // and the day this was written the first one ran out at 1,000 requests and
  // took retrieval down with it for the rest of the day.
  fallbackKey = process.env.SATCHEL_EMBEDDING_FALLBACK_KEY,
  fallbackUrl = process.env.SATCHEL_EMBEDDING_FALLBACK_URL,
  // The whole call, including every wait and every retry. The lifecycle hook
  // that calls this has a ten second timeout, so the useful question is never
  // "how long is a retry" but "how much time is left".
  budgetMs = Number(process.env.SATCHEL_EMBEDDING_BUDGET_MS ?? 6000),
  fetchImpl = fetch,
} = {}) {
  const route = key => providerFor({provider, apiKey: key, baseURL, fetchImpl}).textEmbeddingModel(model);
  const routes = [route(apiKey)];
  // Deliberately the same model on both routes, and there is no setting to make
  // it anything else. Each row stores embedding_model beside its vector because
  // two models' vectors are not comparable, so a fallback that answered with a
  // different model would turn a rate limit into quietly wrong matches, which
  // is the one failure this file exists to prevent.
  if (fallbackKey) routes.push(providerFor({
    provider, apiKey: fallbackKey, baseURL: asBaseUrl(fallbackUrl) ?? baseURL, fetchImpl,
  }).textEmbeddingModel(model));

  // The name written to embedding_model. A taskType is part of the space, so it
  // has to be part of the name, or a corpus half-embedded either side of the
  // switch would look uniform and rank against noise.
  const stamp = taskType ? `${model}+retrieval` : model;

  const options = task => ({
    providerOptions: provider === 'google'
      ? {google: {outputDimensionality: dimensions,
          ...(taskType ? {taskType: TASK_TYPES[task] ?? TASK_TYPES.document} : {})}}
      : {openai: {dimensions}},
    // maxRetries 0 on purpose. The SDK's own backoff cannot know that a per-day
    // quotaId means waiting is pointless, and its default of two retries would
    // spend the hook's whole timeout learning that. The loop below decides.
    maxRetries: 0,
    telemetry: {functionId: 'embed', metadata: {task, dimensions, model: stamp}},
  });

  // Budgeted rather than counted. An advised wait that does not fit in what is
  // left is not waited at all: holding the turn open and then failing anyway is
  // strictly worse than failing now, because the caller degrades to silence
  // either way and the person gets the answer sooner.
  async function attempt(inputs, task) {
    const deadline = Date.now() + budgetMs;
    let last = null;
    for (const model_ of routes) {
      for (;;) {
        const left = deadline - Date.now();
        // Under a quarter second there is no attempt worth starting, only a
        // timeout to report.
        if (left < 250) break;
        const signal = AbortSignal.timeout(Math.min(timeoutMs, left));
        try {
          const call = {model: model_, abortSignal: signal, ...options(task)};
          // embedMany preserves input order across whatever chunking the
          // provider needs, which the backfill depends on: it writes
          // vectors[i] onto rows[i], so a reordered response would store each
          // memory's vector on a different memory, with every row still
          // holding a valid unit vector and nothing to show for it but
          // quietly wrong matches.
          const result = inputs.length === 1
            ? await sdkEmbed({...call, value: inputs[0]}).then(r => [r.embedding])
            : await embedMany({...call, values: inputs}).then(r => r.embeddings);
          if (!Array.isArray(result) || result.length !== inputs.length)
            throw new EmbeddingError(`${model} returned ${result?.length ?? 0} embeddings for ${inputs.length} inputs`);
          return result;
        } catch (error) {
          if (error instanceof EmbeddingError) throw error;
          const {kind, status} = describeFailure(error, signal);
          if (kind === 'timeout') {
            // A host that did not answer inside the timeout will not answer
            // sooner for being asked again on the same route.
            last = new EmbeddingError(`${model} did not respond within ${Math.min(timeoutMs, left)}ms`,
              {cause: error, code: 'EMB_TIMEOUT', reason: 'the embedding service did not answer in time'});
            break;
          }
          if (kind === 'shape') {
            // Not worth another attempt and not worth another key: the host
            // answered, it just did not answer with embeddings.
            throw new EmbeddingError(`${model} returned a response that is not embeddings`,
              {cause: error, code: 'EMB_SHAPE', reason: 'the embedding service sent something unreadable'});
          }
          if (kind === 'host') {
            last = new EmbeddingError(`${model} returned ${status}`,
              {cause: error, code: 'EMB_HOST', reason: `the embedding service answered ${status}`});
            break;
          }
          const limit = readApiFailure(error);
          last = new EmbeddingError(`${model} is rate limited: ${limit.reason}${limit.quota ? ` [${limit.quota}]` : ''}`,
            {cause: error, code: 'EMB_LIMIT', retryAfterMs: limit.retryAfterMs,
             reason: `embedding is rate limited, ${limit.reason}`});
          // A spent daily quota does not come back from a wait. Google answers
          // one with a ten second retryDelay anyway, which is the bucket
          // refilling, so honouring it buys a single request and then fails
          // again: that is what made retrieval look flaky instead of out of
          // quota. Go straight to the other key, or stop.
          if (limit.spent) break;
          const wait = limit.retryAfterMs || 500;
          if (Date.now() + wait + 250 > deadline) break;
          await sleep(wait);
        }
      }
    }
    throw last ?? new EmbeddingError(`${model} could not be reached`,
      {code: 'EMB_HOST', reason: 'the embedding service could not be reached'});
  }

  return {
    /** What goes in embedding_model. Carries the taskType, because it is part
     *  of the space and not a call option. */
    model: stamp,
    provider, dimensions, taskType: taskType ?? null, routes: routes.length,
    /** Embeds many texts, preserving order. Throws rather than returning a hole.
     *  `task` is 'document' for something being stored and 'query' for a
     *  prompt looking for it; it does nothing unless a taskType is configured. */
    async embed(texts, task = 'document') {
      const inputs = texts.map(text => {
        if (typeof text !== 'string' || !text.trim()) throw new EmbeddingError('Cannot embed empty text');
        return text.slice(0, MAX_CHARS);
      });
      if (!inputs.length) return [];
      return (await attempt(inputs, task)).map(vector => normalize(vector, model, dimensions));
    },
    async embedOne(text, task = 'document') { return (await this.embed([text], task))[0]; },
    /** The prompt side of an asymmetric model. Kept as its own name so a call
     *  site cannot forget which side it is on. */
    async embedQuery(text) { return this.embedOne(text, 'query'); },
  };
}

/** What gets indexed. Measured: statement plus source beats statement alone,
 *  and prefixing the project name is worse than either. See
 *  docs/memory-v2-build.md section 4.10. */
export const indexedText = memory =>
  memory.source?.trim() ? `${memory.statement} ${memory.source}` : memory.statement;

/** Postgres accepts a vector literal as a bracketed list of numbers. */
export const toVectorLiteral = vector => `[${vector.join(',')}]`;
