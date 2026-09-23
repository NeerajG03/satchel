import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEmbedder, EmbeddingError, EMBEDDING_DIMENSIONS, indexedText, toVectorLiteral} from '../server/embedding.mjs';

// The HTTP call belongs to the AI SDK now, so these stubs speak Google's native
// wire shape rather than the OpenAI envelope: :embedContent for one value and
// :batchEmbedContents for several, both answering with `values` arrays. The
// shapes were read off a real call rather than remembered.
const vector = (fill = 1) => Array.from({length: EMBEDDING_DIMENSIONS}, () => fill);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const many = vectors => json({embeddings: vectors.map(values => ({values}))});
const one = values => json({embedding: {values}});
/** Answers whichever endpoint was asked, so a stub works for embed and embedMany. */
const ok = (values = vector(1)) => async (_url, init) => {
  const body = JSON.parse(init.body);
  return body.requests ? many(body.requests.map(() => values)) : one(values);
};
const embedder = options => createEmbedder({apiKey: 'k', ...options});

test('embeddings are normalised, so a stored vector means the same as a query vector', async () => {
  // gemini-embedding-001 returns an un-normalised vector at 768 dimensions and
  // a normalised one at 3072. The SDK does not normalise either, so this stays
  // ours: cosine distance and dot product only agree if it happens.
  const [result] = await embedder({fetchImpl: ok(vector(3))}).embed(['anything']);
  const length = Math.hypot(...result);
  assert.ok(Math.abs(length - 1) < 1e-9, `expected unit length, got ${length}`);
});

test('order is preserved across batch boundaries', async () => {
  // The backfill writes vectors[i] onto rows[i], so a reordered response would
  // store each memory's vector on a different memory, with every row still
  // holding a valid unit vector and nothing to show for it but wrong matches.
  const fetchImpl = async (_url, init) => {
    const {requests} = JSON.parse(init.body);
    return many(requests.map(r => {
      const v = vector(0); v[0] = 1; v[1] = Number(r.content.parts[0].text.split(' ')[1]);
      return v;
    }));
  };
  const texts = Array.from({length: 150}, (_, i) => `text ${i}`);
  const out = await embedder({fetchImpl}).embed(texts);
  assert.equal(out.length, 150);
  // The second component encodes position, and normalisation preserves order.
  for (let i = 1; i < out.length; i++) assert.ok(out[i][1] >= out[i - 1][1], `position ${i} out of order`);
});

test('a wrong dimension count is refused rather than stored', async () => {
  await assert.rejects(embedder({fetchImpl: ok([1, 2, 3])}).embed(['anything']),
    /3 dimensions, expected 768/);
});

test('a model that ignores the dimension request is refused, not stored short', async () => {
  await assert.rejects(embedder({fetchImpl: ok(Array.from({length: 2048}, () => 1))}).embed(['anything']),
    /2048 dimensions, expected 768/);
});

test('a zero vector is refused, and a hole in the array never reaches us', async () => {
  // An all-zero vector is valid JSON and valid numbers, so it gets past the
  // SDK and this is the only thing that catches it.
  await assert.rejects(embedder({fetchImpl: ok(vector(0))}).embed(['anything']), /zero vector/);
  // A missing or non-numeric component now fails the SDK's own response
  // validation first, so it arrives as a shape error rather than reaching
  // normalize(). The non-finite guard in normalize stays as a cheap invariant
  // for a non-HTTP embedder, but JSON cannot carry NaN, so over the wire this
  // is the path that actually runs.
  const holed = vector(1); holed[7] = null;
  await assert.rejects(embedder({fetchImpl: ok(holed)}).embed(['anything']), error => {
    assert.equal(error.code, 'EMB_SHAPE');
    return true;
  });
});

test('empty text is refused before a request is made', async () => {
  let called = false;
  await assert.rejects(embedder({fetchImpl: async () => { called = true; }}).embed(['   ']), /empty/);
  assert.equal(called, false);
});

test('the dimension request actually travels, at 768 to fit the indexed column', async () => {
  // pgvector indexes up to 2,000 dimensions and this model defaults to 3,072,
  // so without this the column needs halfvec and 2.7x the storage.
  let sent;
  await embedder({fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return one(vector(1)); }})
    .embed(['anything']);
  assert.equal(sent.outputDimensionality, 768);
});

// ---------------------------------------------------------------------------
// Rate limits. This is the 21 Sep 2026 outage, where retrieval failed more
// often than it succeeded and said only "gemini-embedding-001 returned 429".
// The real answer was in the response body, which nothing read.

/** A 429 shaped the way Google actually sends one: no rate limit headers at
 *  all, and the quota, the limit and the retry delay in the body. */
const geminiLimit = (quotaId, retryDelay = '9s', seconds = '9.878146082') => json({error: {
  code: 429,
  message: `Quota exceeded for metric: generativelanguage.googleapis.com/embed_content_free_tier_requests, limit: 1000, model: gemini-embedding-1.0\nPlease retry in ${seconds}s.`,
  status: 'RESOURCE_EXHAUSTED',
  details: [
    {'@type': 'type.googleapis.com/google.rpc.QuotaFailure',
     violations: [{quotaMetric: 'generativelanguage.googleapis.com/embed_content_free_tier_requests',
       quotaId, quotaValue: '1000'}]},
    {'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay},
  ],
}}, 429);
const DAILY = 'EmbedContentRequestsPerDayPerProjectPerModel-FreeTier';
const PER_MINUTE = 'EmbedContentRequestsPerMinutePerProjectPerModel-FreeTier';

test('a spent daily quota is not waited out, because waiting cannot fix it', async () => {
  // Google answers an exhausted per-day quota with a ~10 second retryDelay,
  // which reads exactly like a burst limit and is not one: it is the bucket
  // refilling at 1000 a day. Honouring it buys one request and then fails
  // again, which is what made retrieval look flaky rather than out of quota.
  // maxRetries is 0 on the SDK call precisely so this stays our decision.
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    embedder({fetchImpl: async () => { calls++; return geminiLimit(DAILY); }}).embed(['anything']),
    error => {
      assert.equal(error.code, 'EMB_LIMIT');
      assert.match(error.reason, /day's free quota is used up \(1000 requests\)/);
      return true;
    });
  assert.equal(calls, 1, 'a spent daily quota is asked once and reported, not retried');
  assert.ok(Date.now() - started < 500, 'and nothing sleeps on the way out');
});

test('a short advised wait is honoured, and the retry is what succeeds', async () => {
  let calls = 0;
  const [result] = await embedder({fetchImpl: async (url, init) => {
    calls++;
    return calls === 1 ? geminiLimit(PER_MINUTE, '0s', '0.05') : ok(vector(1))(url, init);
  }}).embed(['anything']);
  assert.equal(result.length, EMBEDDING_DIMENSIONS);
  assert.equal(calls, 2);
});

test('an advised wait that does not fit the budget is not taken', async () => {
  // Sleeping past the hook's own timeout means holding the turn open and then
  // failing anyway, which is strictly worse than failing now: the caller
  // degrades to silence either way and the person hears about it sooner.
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    embedder({budgetMs: 600, fetchImpl: async () => { calls++; return geminiLimit(PER_MINUTE, '30s', '30'); }})
      .embed(['anything']), /rate limited/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 600, `gave up inside the budget, took ${Date.now() - started}ms`);
});

test('Retry-After in seconds and an epoch reset are both read', async () => {
  // Three hosts, three ways of saying the same thing. Reading only
  // x-ratelimit-reset, which Google never sends, meant every Gemini limit fell
  // through to a 500ms floor. The SDK hands these back on APICallError as a
  // plain object rather than a Headers instance, which is its own trap.
  const seen = [];
  for (const headers of [{'retry-after': '0.05'}, {'x-ratelimit-reset': String(Date.now() + 50)}]) {
    let calls = 0;
    await embedder({fetchImpl: async (url, init) => {
      calls++;
      if (calls === 1) return new Response('{}', {status: 429, headers});
      return ok(vector(1))(url, init);
    }}).embed(['anything']);
    seen.push(calls);
  }
  assert.deepEqual(seen, [2, 2], 'both spellings of "try again shortly" have to be understood');
});

test('a second key is tried for the same model, and only for the same model', async () => {
  // Gemini's free embedding quota is per project per model, so a second
  // project doubles it. The model is deliberately not configurable per route:
  // each row stores embedding_model beside its vector because two models'
  // vectors are not comparable, so a fallback answering with a different model
  // would turn a rate limit into quietly wrong matches.
  const asked = [];
  const [result] = await embedder({
    apiKey: 'first', fallbackKey: 'second',
    baseURL: 'https://primary/v1beta', fallbackUrl: 'https://secondary/v1beta',
    fetchImpl: async (url, init) => {
      asked.push({url: String(url), key: init.headers['x-goog-api-key'] ?? init.headers.authorization});
      return asked.length === 1 ? geminiLimit(DAILY) : ok(vector(1))(url, init);
    },
  }).embed(['anything']);
  assert.equal(result.length, EMBEDDING_DIMENSIONS);
  assert.ok(asked[0].url.startsWith('https://primary/v1beta/'), asked[0].url);
  assert.ok(asked[1].url.startsWith('https://secondary/v1beta/'), asked[1].url);
  assert.deepEqual(asked.map(a => a.key), ['first', 'second']);
  // Same model id on both routes, which is the whole safety property.
  assert.equal(asked[0].url.split('/').pop(), asked[1].url.split('/').pop());
});

test('every failure carries a plain-words reason, not only a status', async () => {
  // The hook turns this into the line the person reads. Without it every
  // failure here arrived as "Satchel request failed. Reload before retrying a
  // write: it may have completed", which is unhelpful and also untrue.
  //
  // The three shape cases were found by probing, not by reading class names: a
  // count mismatch raises InvalidResponseDataError rather than APICallError,
  // and an unreadable body raises APICallError with statusCode 200, so both
  // used to be reported as a timeout and as "the service answered 200".
  const cases = [
    ['a server error', ['a'], async () => json({error: {message: 'upstream'}}, 503),
      'EMB_HOST', /answered 503/],
    ['a spent quota', ['a'], async () => geminiLimit(DAILY), 'EMB_LIMIT', /quota is used up/],
    ['a short batch', ['a', 'b'], async () => many([vector(1)]), 'EMB_SHAPE', /unreadable/],
    ['a body that is not json', ['a'], async () => new Response('<html>', {status: 200}),
      'EMB_SHAPE', /unreadable/],
  ];
  for (const [label, texts, fetchImpl, code, reason] of cases) {
    await assert.rejects(embedder({budgetMs: 800, fetchImpl}).embed(texts), error => {
      assert.equal(error.code, code, label);
      assert.match(error.reason, reason, label);
      return true;
    });
  }
});

test('a host that never answers is a timeout, and gives up inside the budget', async () => {
  const started = Date.now();
  await assert.rejects(
    // The held timer stands in for the socket a real request keeps open.
    // AbortSignal.timeout does not keep the process alive, so without it Node
    // sees nothing pending, exits mid-test and cancels the rest of the file.
    embedder({timeoutMs: 200, budgetMs: 700, fetchImpl: (_url, init) =>
      new Promise((_, reject) => {
        const socket = setTimeout(() => {}, 5000);
        init.signal?.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
      })})
      .embed(['anything']),
    error => {
      assert.equal(error.code, 'EMB_TIMEOUT');
      assert.match(error.reason, /did not answer in time/);
      return true;
    });
  assert.ok(Date.now() - started < 900, `took ${Date.now() - started}ms`);
});

// ---------------------------------------------------------------------------
// taskType. Off by default, and that is the point.

test('no taskType is sent unless one is configured, because it changes the space', async () => {
  // Every vector already stored was embedded without one. Switching it on
  // without re-embedding would compare stored vectors against query vectors
  // from a different space: retrieval gets quietly worse and nothing fails.
  let sent;
  const spy = async (url, init) => { sent = JSON.parse(init.body); return ok(vector(1))(url, init); };
  const plain = embedder({fetchImpl: spy});
  await plain.embedQuery('anything');
  assert.equal(sent.taskType, undefined);
  assert.equal(plain.model, 'gemini-embedding-001', 'the stamp is the plain model id');
});

test('an asymmetric model is asked the right question on each side', async () => {
  // gemini-embedding-001 wants the stored side and the asking side embedded
  // differently. The OpenAI compatibility layer had no field for it, so this
  // was unreachable until the native provider.
  let sent;
  const spy = async (url, init) => { sent = JSON.parse(init.body); return ok(vector(1))(url, init); };
  const tuned = embedder({taskType: 'retrieval', fetchImpl: spy});
  await tuned.embedQuery('what did we decide');
  assert.equal(sent.taskType, 'RETRIEVAL_QUERY');
  await tuned.embedOne('a memory being stored', 'document');
  assert.equal(sent.taskType, 'RETRIEVAL_DOCUMENT');
  // And the space it produces is named differently, so embedding_model still
  // tells the two apart and the backfill knows the corpus needs re-embedding.
  assert.equal(tuned.model, 'gemini-embedding-001+retrieval');
});

test('an OpenAI-shaped host is still one setting away', async () => {
  // The raw fetch version kept this property on purpose: OpenRouter, OpenAI
  // itself and a local ollama on /v1 are a url and a provider name, not a fork.
  const asked = [];
  await createEmbedder({provider: 'openai', apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1',
    fetchImpl: async (url, init) => {
      asked.push(String(url));
      const {input} = JSON.parse(init.body);
      return json({data: (Array.isArray(input) ? input : [input]).map((_, index) => ({index, embedding: vector(1)}))});
    }}).embed(['anything']);
  assert.deepEqual(asked, ['https://openrouter.ai/api/v1/embeddings']);
});

test('a url naming the old full endpoint is trimmed rather than left to 404', async () => {
  // The env vars used to name a complete endpoint, because the raw fetch
  // version appended nothing. The SDK adds the path itself.
  const asked = [];
  await createEmbedder({provider: 'openai', apiKey: 'k', baseURL: 'https://host/v1/embeddings',
    fetchImpl: async (url, init) => {
      asked.push(String(url));
      const {input} = JSON.parse(init.body);
      return json({data: (Array.isArray(input) ? input : [input]).map((_, index) => ({index, embedding: vector(1)}))});
    }}).embed(['anything']);
  assert.deepEqual(asked, ['https://host/v1/embeddings']);
});

test('the indexed text is the statement plus its source, when there is one', () => {
  assert.equal(indexedText({statement: 'A.', source: 'they said A'}), 'A. they said A');
  assert.equal(indexedText({statement: 'A.', source: '  '}), 'A.');
});

test('a vector literal is the bracketed form Postgres parses', () => {
  assert.equal(toVectorLiteral([1, 2.5, -3]), '[1,2.5,-3]');
});

test('an unknown provider is a configuration error, not a silent default', () => {
  // "Any OpenAI-shaped host" is about the url, not about accepting any string
  // as a provider name. Without this a typo in SATCHEL_EMBEDDING_PROVIDER
  // would quietly become a call to whatever the default host happened to be.
  assert.throws(() => createEmbedder({provider: 'nonsense', apiKey: 'k'}),
    /Unknown model provider nonsense/);
});
