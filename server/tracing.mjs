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
import {NodeSDK} from '@opentelemetry/sdk-node';
import {LangfuseSpanProcessor} from '@langfuse/otel';
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
    new NodeSDK({spanProcessors: [processor]}).start();
  } catch { processor = null; }
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

/** A model call that produces text. Typed as a generation so Langfuse can do
 *  model-level cost and latency analytics on it. */
export const generation = (name, attrs) => observation(name, 'generation', attrs);

/** An embedding call. Langfuse types this separately from a generation, which
 *  keeps the agent graph and the latency breakdown honest. */
export const embedding = (name, attrs) => observation(name, 'embedding', attrs);

/** A lookup. Typed as a retriever so the retrieval step is distinguishable from
 *  the model calls around it. */
export const retrieval = (name, attrs) => observation(name, 'retriever', attrs);

const noop = {end() {}, fail() {}};

/** Serverless functions can freeze as soon as they respond, so a batched
 *  exporter would lose the trace. This is awaited before the handler returns. */
export async function flush() {
  if (!processor) return;
  try { await processor.forceFlush(); } catch { /* a lost trace is not a failed request */ }
}
