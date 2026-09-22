// Which SDK provider a model id is asked through.
//
// Google natively rather than through its OpenAI compatibility layer, because
// two things only exist on the native API and both matter here: `taskType` on
// embeddings, which is the one retrieval lever we have never pulled, and
// structured output that the provider enforces rather than asks for.
//
// Everything else speaks the OpenAI shape. That keeps the property the raw
// fetch version had on purpose: OpenRouter, OpenAI itself and a local ollama on
// its /v1 endpoint are a change of two environment variables, not a change of
// code.
import {APICallError} from 'ai';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';

// Where each provider lives when nothing overrides it. Named rather than
// open-ended so a typo in SATCHEL_EMBEDDING_PROVIDER is a startup error instead
// of a silent call to the wrong host: "any OpenAI-shaped host" is about the
// url, not about accepting any string as a provider name.
/** The older env vars named a full endpoint, because the raw fetch version
 *  appended nothing. The SDK wants the base and adds the path itself, so a
 *  value carrying the old suffix is trimmed rather than left to 404. Applied
 *  inside providerFor so it covers a value passed in code as well as one read
 *  from the environment. */
export const asBaseUrl = url => typeof url === 'string' && url
  ? url.replace(/\/+$/, '').replace(/\/(chat\/completions|embeddings)$/, '')
  : undefined;

const HOSTS = {
  google: undefined,   // the SDK's own default, https://generativelanguage.googleapis.com/v1beta
  openai: 'https://generativelanguage.googleapis.com/v1beta/openai',
  'openai-compatible': 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
};

/** `fetchImpl` is threaded through rather than left to the global, because it
 *  is what lets every test in this repo drive the real call path against a
 *  stubbed response instead of a hand-written fake. Three bugs that made
 *  Memory v2 inert shipped past a fake-driven suite. */
export function providerFor({provider = 'google', apiKey, baseURL, fetchImpl = fetch} = {}) {
  if (!(provider in HOSTS))
    throw new Error(`Unknown model provider ${provider}. One of: ${Object.keys(HOSTS).join(', ')}`);
  const url = asBaseUrl(baseURL) ?? HOSTS[provider];
  if (provider === 'google')
    return createGoogleGenerativeAI({apiKey, fetch: fetchImpl, ...(url ? {baseURL: url} : {})});
  return createOpenAICompatible({name: provider, apiKey, fetch: fetchImpl, baseURL: url});
}


/** What kind of failure an SDK call produced.
 *
 * Written after probing each case rather than from the class names, because
 * three of them classify wrongly on a first reading:
 *
 *   a count mismatch raises InvalidResponseDataError, which is not an
 *   APICallError, so treating "not an APICallError" as a timeout reported a
 *   malformed response as "the service did not answer in time";
 *
 *   an unreadable body on a successful request still raises APICallError, with
 *   statusCode 200, so reporting the status gives a person "the service
 *   answered 200", which is not a failure anyone can act on;
 *
 *   and only an abort is really a timeout, which has to be read from the
 *   signal, because the SDK surfaces it as an ordinary error.
 */
/** The model to fall back to when the chosen one is unavailable.
 *
 *  Not a nicety. The newest Gemini flash models answer 503 "experiencing high
 *  demand" under load, and on 22 September gemini-3.8-flash and
 *  gemini-3.7-flash did so on every single attempt while gemini-3.5-flash
 *  answered in four seconds. Pinning the newest model without this means
 *  consolidation is simply broken on the days it is busy, and the person
 *  pressing the button has no way to tell that from a bug.
 *
 *  One older model, not a chain. A chain is a way to never find out that your
 *  first choice does not work. */
export const fallbackModel = model => {
  const chosen = process.env.SATCHEL_MODEL_FALLBACK ?? 'gemini-3.5-flash';
  return chosen && chosen !== model ? chosen : null;
};

/** Whether trying a different model is worth doing.
 *
 *  Two failures, and they look nothing alike. The host cannot answer at all,
 *  which is a 5xx. Or this model's quota is gone for the day, which on the
 *  free tier is a per-model daily cap: gemini-3.8-flash allows 20 requests a
 *  day and then answers 429 until midnight.
 *
 *  The second one is the reason this predicate is not just "5xx". A spent
 *  daily quota is per model, so the same question asked of another one is
 *  answered immediately, and without this a free key gets 20 consolidations
 *  and then silence.
 *
 *  Nothing else. A 4xx that is not a quota is the request, and another model
 *  refuses it identically. A burst limit comes back on its own and is worth
 *  waiting out rather than switching for. A timeout has already spent the
 *  budget, and a bad shape is the prompt. */
export const worthAnotherModel = failure =>
  (failure?.code === 'ROUTER_HOST' && Number(failure.status) >= 500)
  || (failure?.code === 'ROUTER_LIMIT' && failure?.spent === true);

export function describeFailure(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError')
    return {kind: 'timeout'};
  if (!APICallError.isInstance(error)) return {kind: 'shape'};
  const status = error.statusCode;
  if (status === 429) return {kind: 'limit', status};
  // A 2xx that still failed is the body, not the host.
  if (typeof status === 'number' && status < 400) return {kind: 'shape', status};
  return {kind: 'host', status};
}
