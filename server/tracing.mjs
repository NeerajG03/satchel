// Langfuse tracing, registered once per process.
//
// Two things make this different from a normal Node setup. The handler runs on
// Vercel, where the function can freeze the moment it responds, so spans have to
// be flushed before the response rather than on a timer. And the spans carry
// conversation text, which is the most sensitive thing this service handles, so
// what gets recorded is decided explicitly rather than by capturing whatever a
// wrapper happened to see.
//
// Tracing must never change behaviour. Every export here is safe to call when
// Langfuse is not configured, and nothing in this file can throw into a request.
import {registerTelemetry} from 'ai';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {LangfuseSpanProcessor} from '@langfuse/otel';
import {LangfuseVercelAiSdkIntegration} from '@langfuse/vercel-ai-sdk';
import {LangfuseOtelSpanAttributes as LF} from '@langfuse/core';
import {startActiveObservation, startObservation, propagateAttributes, setActiveTraceIO,
        updateActiveObservation} from '@langfuse/tracing';

export const tracingEnabled = Boolean(
  process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

let processor = null;
if (tracingEnabled) {
  try {
    processor = new LangfuseSpanProcessor({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST,
      environment: process.env.VERCEL_ENV ?? 'development',
      // The prompt carries the user's own words. Their content is the point of
      // the trace, so it is kept, but anything that could authenticate or
      // identify beyond the owner id is removed before it leaves the process.
      mask: ({data}) => redact(data),
    });
    new NodeSDK({spanProcessors: [genAiToLangfuse(processor)]}).start();
    // Every AI SDK call now emits its own spans, typed by the SDK: an
    // `embeddings {modelId}` observation for embed/embedMany and a generation
    // for generateObject, with token usage attached by the provider rather
    // than by us reading an envelope.
    //
    // This replaces hand-written generation() and embedding() wrappers, and
    // with them a whole class of bug: the 429 branch used to return into a
    // fresh attempt without ending its span, so rate-limited calls, the ones
    // most worth having, were the ones never recorded.
    registerTelemetry(new LangfuseVercelAiSdkIntegration());
  } catch { processor = null; }
}

// The AI SDK describes its calls in OpenTelemetry's GenAI semantic conventions:
// gen_ai.request.model, gen_ai.usage.input_tokens, gen_ai.input.messages and so
// on. Langfuse reads its own langfuse.observation.* attributes and, as of
// @langfuse/otel 5.11, only looks at the gen_ai ones to pull media out of
// messages. Nothing carries the model or the token counts across.
//
// The effect is quiet and expensive: the observation still arrives, correctly
// typed and timed, with the prompt and the reply on it, and the model, the
// usage and therefore the cost are simply absent. Adding the model definitions
// did not fix it, and a model whose definition has existed since 2025 did not
// resolve either, which is what ruled the definitions out.
//
// So the attributes are translated on the way out. Anything Langfuse has
// already set wins, because a hand-set value is deliberate.
const GEN_AI_USAGE = {
  'gen_ai.usage.input_tokens': 'input',
  'gen_ai.usage.output_tokens': 'output',
  'gen_ai.usage.cache_read.input_tokens': 'cache_read_input',
  'gen_ai.usage.reasoning.output_tokens': 'reasoning_output',
};

export function genAiToLangfuse(inner) {
  const bridge = span => {
    const a = span.attributes;
    if (!a || a[LF.OBSERVATION_MODEL]) return;
    const model = a['gen_ai.response.model'] ?? a['gen_ai.request.model'];
    if (!model) return;
    a[LF.OBSERVATION_MODEL] = model;
    const usage = {};
    for (const [from, to] of Object.entries(GEN_AI_USAGE))
      if (typeof a[from] === 'number') usage[to] = a[from];
    // Langfuse derives total itself when the parts are there, but a provider
    // that reports only a total would otherwise contribute nothing.
    if (Object.keys(usage).length) a[LF.OBSERVATION_USAGE_DETAILS] = JSON.stringify(usage);
    if (!a[LF.OBSERVATION_INPUT] && a['gen_ai.input.messages'])
      a[LF.OBSERVATION_INPUT] = a['gen_ai.input.messages'];
    if (!a[LF.OBSERVATION_OUTPUT] && a['gen_ai.output.messages'])
      a[LF.OBSERVATION_OUTPUT] = a['gen_ai.output.messages'];
    const parameters = {};
    for (const key of ['temperature', 'max_tokens', 'top_p'])
      if (a[`gen_ai.request.${key}`] !== undefined) parameters[key] = a[`gen_ai.request.${key}`];
    if (Object.keys(parameters).length && !a[LF.OBSERVATION_MODEL_PARAMETERS])
      a[LF.OBSERVATION_MODEL_PARAMETERS] = JSON.stringify(parameters);
  };
  return {
    onStart: (span, context) => inner.onStart?.(span, context),
    onEnd(span) {
      // Never let a translation failure cost the span itself.
      try { bridge(span); } catch { /* the observation is worth more than the mapping */ }
      inner.onEnd?.(span);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
}

const SECRETS = /\b(sk-[a-z0-9-]{8,}|pk-lf-[a-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}|AQ\.[A-Za-z0-9_-]{10,})/gi;
function redact(value) {
  if (typeof value === 'string') return value.replace(SECRETS, '[redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  return value;
}

/** Wraps one lifecycle event in a trace. Returns the callback's value
 *  untouched, and swallows any tracing failure rather than turning it into a
 *  request failure. */
export async function traced(name, {sessionId, userId, metadata, tags, input} = {}, run) {
  if (!processor) return run(() => {}, () => {});
  try {
    // sessionId groups every turn of one conversation, which is the view that
    // makes a memory decision explicable: what was already in context when this
    // was captured. userId is the owner, never an email or a token.
    // tags belong on propagateAttributes, not on the span: in v5 correlating
    // attributes live on every observation, so setting them on one span leaves
    // its children untagged and unfilterable.
    return await propagateAttributes({sessionId, userId, metadata, tags}, () =>
      startActiveObservation(name, async span => {
        let current = input;
        span.update({input: current});
        setActiveTraceIO({input: current});
        return run(output => {
          span.update({output});
          setActiveTraceIO({input: current, output});
        }, replacement => {
          // Some events only learn what they are about after the work starts:
          // a Stop hook does not know the turn until it reads the window. A
          // trace whose input is the literal string "Stop" is unreadable.
          current = replacement;
          span.update({input: current});
          setActiveTraceIO({input: current});
        });
      }));
  } catch { return run(() => {}, () => {}); }
}

/** Adds detail to the observation that is currently active. */
export function annotate(attributes) {
  if (!processor) return;
  try { updateActiveObservation(attributes); } catch { /* never fail over a trace */ }
}

function observation(name, asType, {model, input, metadata} = {}) {
  if (!processor) return noop;
  try {
    const span = startObservation(name, {model, input, metadata}, {asType});
    return {
      end(output, extra = {}) {
        try { span.update({output, ...extra}).end(); }
        catch { /* never fail a request over a trace */ }
      },
      fail(error) {
        try { span.update({level: 'ERROR', statusMessage: String(error?.message ?? error)}).end(); }
        catch { /* as above */ }
      },
    };
  } catch { return noop; }
}

/** A lookup. Typed as a retriever so the retrieval step is distinguishable from
 *  the model calls around it.
 *
 *  This is the only observation still opened by hand, because it is the only
 *  one that is not a model call: it is our own database query, and the AI SDK
 *  has no opinion about it. */
export const retrieval = (name, attrs) => observation(name, 'retriever', attrs);

const noop = {end() {}, fail() {}};

/** Serverless functions can freeze as soon as they respond, so a batched
 *  exporter would lose the trace. This is awaited before the handler returns. */
export async function flush() {
  if (!processor) return;
  try { await processor.forceFlush(); } catch { /* a lost trace is not a failed request */ }
}
