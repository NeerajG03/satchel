// The router: one small model call at the end of a turn that decides whether
// anything the user said is worth keeping.
//
// It is not an agent. No tools, no memory of its own, no access to what is
// already stored. It sees a rolling window of the conversation and returns a
// list, and an empty list is the answer on most turns.
//
// The one rule that keeps automatic capture safe is that a statement must be
// something the user would recognise as their own claim. So every item carries
// `source`, a span the user actually typed in this turn. Rewording is allowed
// and necessary; inventing is not. Any dispute about whether a memory is real
// is settled by looking at the source.

import {z} from 'zod';
import {generateObject, APICallError, NoObjectGeneratedError} from 'ai';
import {readApiFailure} from './rate-limit.mjs';
import {providerFor, asBaseUrl, describeFailure} from './model-provider.mjs';

export class RouterError extends Error {
  constructor(message, {cause, code, reason} = {}) {
    super(message);
    this.name = 'RouterError';
    this.cause = cause;
    // Carried so the hook can tell the person what happened. A capture that
    // did not run because the day's quota is spent is a different thing from
    // one that found nothing worth keeping, and they looked identical.
    if (code) this.code = code;
    if (reason) this.reason = reason;
  }
}

// The shape the provider is made to return. It was a hand-written JSON Schema
// plus a prose fallback plus a fence-stripping parser, because not every host
// accepts a schema and the ones that refuse reject the whole request. The SDK
// owns that negotiation now, and zod was already a dependency, so the schema is
// the validator rather than a second description of it that can drift.
export const ROUTER_SCHEMA = z.object({
  memories: z.array(z.object({
    statement: z.string().describe('The claim, written so it still makes sense in six weeks.'),
    source: z.string().describe('The words the user actually typed that this came from.'),
    project: z.string().nullable().describe('A project slug from the list, or null for personal.'),
    task: z.string().nullable().describe('An open task slug from the list, or null.'),
  })),
});

const INSTRUCTIONS = `You read the end of a conversation and decide whether the user said anything worth remembering.

Return a list. An empty list is a normal and correct answer. Do not add an item to seem useful.

Keep a claim when it would still be true and still be useful in six weeks. In practice that is:
- a preference about how they want things done: "no em dashes", "give me one recommendation, not three options"
- a decision they made and the shape of it: "entries are append only, corrections are reversing entries"
- a constraint or a rule: "never bump the Go version until payouts are finished"
- a durable fact about their work or their life: a figure, a deadline, who owns what, how something is configured
- something about a person: what they are responsible for, what they always ask for

Do not keep:
- anything the assistant said, suggested or concluded. Only the user's own claims.
- the current moment: what is open, what is running, what just failed, what you are about to do next
- a question, or thinking out loud that the user did not land on
- a one-off instruction for this task alone: "make it shorter", "try again", "use the other one"
- a bare continuation with no content: "go on", "yeah that one", "keep going"

Two worked examples.

The user types: "ok so no personas in v1, and don't use em dashes anywhere. also the consent page still has that corner leak on .paper"
You return three items: "no personas in v1" scoped to the project being worked on; "don't use em dashes anywhere" with project null, because it applies everywhere; and the corner leak scoped to the project, and to the open task about it if one is listed.

The user types: "go on, and make that shorter"
You return an empty list. Neither part is durable.

For each thing you keep:
- "statement" is the claim written clearly. Fix grammar, drop filler, resolve a pronoun whose referent is in this window, and keep the user's own vocabulary. Do not add a reason they did not give, do not widen it, and do not merge two separate claims into one.
- "source" must be text the user actually typed in the turn being classified. Copy it exactly. If you cannot point at the words, do not keep the item.
- "project" is a slug from the projects list when the claim is about that project, otherwise null. Null means it applies everywhere, which is the safer mistake.
- "task" is a slug from the open tasks list only when the claim is plainly about that task, otherwise null.

Split one message into several items only when the parts already stand alone. "no jargon, no em dashes" is two. "no personas and no curator in v1" is one.`;

/** The window the model sees. Context is for understanding only; only the turn
 *  being classified can supply a source. */
export function buildPrompt({projects = [], tasks = [], context = [], turn = []}) {
  const lines = [INSTRUCTIONS, ''];
  if (projects.length) {
    const width = Math.max(...projects.map(p => p.slug.length));
    lines.push('projects');
    for (const p of projects) lines.push(`  ${p.slug.padEnd(width)}  ${(p.brief ?? '').slice(0, 80)}`.trimEnd());
    lines.push('');
  }
  if (tasks.length) {
    const width = Math.max(...tasks.map(t => t.slug.length));
    lines.push('open tasks');
    for (const t of tasks) lines.push(`  ${t.slug.padEnd(width)}  ${(t.title ?? '').slice(0, 80)}`.trimEnd());
    lines.push('');
  }
  if (context.length) {
    lines.push('earlier in this conversation, for understanding only, never a source');
    for (const entry of context)
      lines.push(`  ${entry.role}: ${entry.content.slice(0, entry.role === 'assistant' ? 800 : 2000)}`);
    lines.push('');
  }
  lines.push('classify only what the user said in this turn:');
  lines.push('<turn>');
  for (const message of turn) lines.push(message);
  lines.push('</turn>');
  return lines.join('\n');
}

/** Everything the model returned that does not hold up is dropped here rather
 *  than reaching the database. A router that occasionally says nothing is the
 *  behaviour we already have; one that invents is a new failure. */
export function validate(payload, {turn = [], projects = [], tasks = []}) {
  const haystack = turn.join('\n').toLowerCase();
  const projectSlugs = new Set(projects.map(p => p.slug));
  const taskBySlug = new Map(tasks.map(t => [t.slug, t]));
  const kept = [];
  const dropped = [];
  for (const item of payload?.memories ?? []) {
    const statement = String(item?.statement ?? '').trim();
    const source = String(item?.source ?? '').trim();
    if (!statement || statement.length > 500) { dropped.push({item, why: 'statement missing or too long'}); continue; }
    if (!source) { dropped.push({item, why: 'no source'}); continue; }
    // The source has to be in what the user typed this turn. This is the check
    // that makes fabrication detectable rather than a matter of trust.
    if (!haystack.includes(source.toLowerCase().slice(0, 60))) {
      dropped.push({item, why: 'source is not in the turn'});
      continue;
    }
    const project = projectSlugs.has(item?.project) ? item.project : null;
    // A task only survives with its project, because a memory may not hang off
    // a task in another scope.
    const task = taskBySlug.get(item?.task);
    const taskProject = task?.project ?? null;
    kept.push({
      statement, source,
      project: task ? taskProject : project,
      task: task ? item.task : null,
    });
  }
  return {memories: kept, dropped};
}

export function createRouter({
  // Measured, not guessed. Over 24 real turns replayed from the corpus and 16
  // that contain nothing durable, gemini-3.5-flash-lite extracted 22 of 24 and
  // stayed quiet on all 16, at about 1.6 seconds. See eval/router.mjs.
  //
  // Pinned rather than -latest on purpose: the instructions above were tuned
  // against this version, and a floating alias would move the thing the
  // measurement describes.
  model = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.5-flash-lite',
  // Google natively, so the provider enforces the schema instead of being
  // asked to follow one. Any OpenAI-shaped host is `openai` plus a url.
  provider = process.env.SATCHEL_ROUTER_PROVIDER ?? 'google',
  baseURL = asBaseUrl(process.env.SATCHEL_ROUTER_URL),
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY,
  timeoutMs = Number(process.env.SATCHEL_ROUTER_TIMEOUT_MS ?? 8000),
  fetchImpl = fetch,
} = {}) {
  return {
    model,
    async route(input) {
      if (!apiKey) throw new RouterError('No router key configured');
      const prompt = buildPrompt(input);
      let lastSignal;
      // One retry, on a short advised wait only. Capture missing a turn is the
      // behaviour Satchel had before capture existed, so a loop here would
      // hold the turn open for no gain, and a spent daily quota does not come
      // back from waiting at all. The SDK's own maxRetries is 0 precisely so
      // this stays a decision made with the 429 body in hand.
      for (let attempt = 0; ; attempt++) {
        try { return await ask(); }
        catch (error) {
          const failure = asRouterError(error, lastSignal);
          const wait = failure.code === 'ROUTER_LIMIT' && !failure.spent ? failure.retryAfterMs || 500 : 0;
          if (attempt > 0 || !wait || wait > 2000) throw failure;
          await new Promise(done => setTimeout(done, wait));
        }
      }

      async function ask() {
      const signal = lastSignal = AbortSignal.timeout(timeoutMs);
      let result;
      try {
        result = await generateObject({
          model: providerFor({provider, apiKey, baseURL, fetchImpl}).languageModel(model),
          schema: ROUTER_SCHEMA,
          prompt,
          temperature: 0,
          abortSignal: signal,
          // One attempt. Capture missing a turn is the behaviour Satchel had
          // before capture existed; the SDK's default of two retries with
          // backoff would hold the turn open to learn what the 429 body
          // already said.
          maxRetries: 0,
          // The whole prompt is the input on purpose. A capture is only
          // explicable if you can see what the router was looking at,
          // including which projects and open tasks it had to choose from.
          telemetry: {functionId: 'router', metadata: {
            projects: input.projects?.length ?? 0,
            openTasks: input.tasks?.length ?? 0,
            contextMessages: input.context?.length ?? 0,
            turnMessages: input.turn?.length ?? 0,
          }},
        });
      } catch (error) {
        // One recovery, and only this one. A host that ignores the schema
        // request still answers in prose, and a model told to return JSON in
        // words sometimes wraps it in a fence or a sentence. Google native
        // enforces the schema so this never fires there, but `openai` hosts
        // are a supported path and losing the recovery would quietly stop
        // capture working on them.
        //
        // This is leniency about the wrapper, never about the contents:
        // whatever comes out is parsed against the same schema, and validate()
        // still has to find the source in what the user typed.
        const salvaged = NoObjectGeneratedError.isInstance(error) && salvage(error.text);
        if (!salvaged) throw asRouterError(error, signal);
        result = {object: salvaged, usage: error.usage ?? null};
      }
      // Everything the model returned still goes through validate(). The schema
      // guarantees the shape; only validate() can check that a source is really
      // in what the user typed, which is what makes fabrication detectable
      // rather than a matter of trust.
      const checked = validate(result.object, input);
      return {...checked, prompt, raw: JSON.stringify(result.object), usage: result.usage ?? null};
      }
    },
  };
}

/** Pulls an object out of a reply that carries one but is not one. Returns
 *  null rather than throwing, so the caller reports the original failure. */
function salvage(text) {
  if (typeof text !== 'string') return null;
  const attempts = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1]);
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const attempt of attempts) {
    const parsed = ROUTER_SCHEMA.safeParse((() => {
      try { return JSON.parse(attempt.trim()); } catch { return null; }
    })());
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** Turns an SDK failure into something the hook can say out loud. These carry
 *  no Postgres code, so without a `reason` they all land on the default branch
 *  of errorText and reach the person as "Satchel request failed. Reload before
 *  retrying a write: it may have completed", which is wrong twice over. */
function asRouterError(error, signal) {
  if (error instanceof RouterError) return error;
  if (NoObjectGeneratedError.isInstance(error))
    return new RouterError('router returned nothing matching the schema',
      {cause: error, code: 'ROUTER_SHAPE', reason: 'the capture model returned nothing usable'});
  const {kind, status} = describeFailure(error, signal);
  if (kind === 'timeout')
    return new RouterError(`router did not respond within its timeout`,
      {cause: error, code: 'ROUTER_TIMEOUT', reason: 'the capture model did not answer in time'});
  if (kind === 'shape')
    return new RouterError('router returned a response that is not usable',
      {cause: error, code: 'ROUTER_SHAPE', reason: 'the capture model returned nothing usable'});
  if (kind === 'host')
    return new RouterError(`router returned ${status}`,
      {cause: error, code: 'ROUTER_HOST', reason: `the capture model answered ${status}`});
  // What the limit says is read rather than guessed. A spent daily quota comes
  // back with a ten second retryDelay that reads exactly like a burst limit, so
  // the reason has to name which one it was or every 429 looks transient.
  const limit = readApiFailure(error);
  return Object.assign(
    new RouterError(`router is rate limited: ${limit.reason}`,
      {cause: error, code: 'ROUTER_LIMIT', reason: `capture is rate limited, ${limit.reason}`}),
    // Read by the single retry above: a spent day and a burst need opposite
    // answers and the status code cannot tell them apart.
    {spent: limit.spent, retryAfterMs: limit.retryAfterMs});
}
