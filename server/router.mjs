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

import {generation} from './tracing.mjs';
import {readRateLimit, readFailure} from './rate-limit.mjs';

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

export const ROUTER_SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: {type: 'string', description: 'The claim, written so it still makes sense in six weeks.'},
          source: {type: 'string', description: 'The words the user actually typed that this came from.'},
          project: {type: ['string', 'null'], description: 'A project slug from the list, or null for personal.'},
          task: {type: ['string', 'null'], description: 'An open task slug from the list, or null.'},
        },
        required: ['statement', 'source', 'project', 'task'],
        additionalProperties: false,
      },
    },
  },
  required: ['memories'],
  additionalProperties: false,
};

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

const JSON_FALLBACK = `Reply with JSON only, no prose and no code fence, in exactly this shape:
{"memories":[{"statement":"...","source":"...","project":null,"task":null}]}
An empty list is {"memories":[]}.`;

/** A model told to return JSON in words sometimes wraps it in a fence or a
 *  sentence. Recovering the object is not being lenient about the contract:
 *  everything inside it is still validated, and a reply with no object in it
 *  still fails. */
function parseJson(text) {
  const attempts = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1]);
  const braced = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (braced) attempts.push(braced);
  for (const attempt of attempts) {
    try { return JSON.parse(attempt.trim()); } catch { /* try the next shape */ }
  }
  throw new RouterError('router returned content that is not JSON');
}

export function createRouter({
  // A full URL, so any OpenAI-compatible host works without a code change.
  // Google's compatibility layer is
  // https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
  // Measured, not guessed. Over 24 real turns replayed from the corpus and 16
  // that contain nothing durable, gemini-3.5-flash-lite extracted 22 of 24 and
  // stayed quiet on all 16, at about 1.6 seconds. See eval/router.mjs.
  //
  // Pinned rather than -latest on purpose: the instructions below were tuned
  // against this version, and a floating alias would move the thing the
  // measurement describes.
  model = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.5-flash-lite',
  url = process.env.SATCHEL_ROUTER_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY,
  timeoutMs = Number(process.env.SATCHEL_ROUTER_TIMEOUT_MS ?? 8000),
  fetchImpl = fetch,
} = {}) {
  return {
    model,
    async route(input) {
      if (!apiKey) throw new RouterError('No router key configured');
      const prompt = buildPrompt(input);
      // The whole prompt is the input on purpose. A capture is only
      // explicable if you can see what the router was looking at, including
      // which projects and open tasks it had to choose from.
      const trace = generation('router', {model, input: prompt, metadata: {
        projects: input.projects?.length ?? 0,
        openTasks: input.tasks?.length ?? 0,
        contextMessages: input.context?.length ?? 0,
        turnMessages: input.turn?.length ?? 0,
      }});
      let body;
      try { body = await call(prompt, true); }
      catch (error) { trace.fail(error); throw error; }
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        trace.fail(new RouterError('no content'));
        throw new RouterError('router returned no content');
      }
      let parsed;
      try { parsed = parseJson(text); }
      catch (error) { trace.fail(error); throw error; }
      const checked = validate(parsed, input);
      // Kept and dropped both, because a router that is being silently filtered
      // looks identical to one that is being conservative.
      trace.end({kept: checked.memories, dropped: checked.dropped},
        {usageDetails: body?.usage ?? undefined,
         metadata: {kept: checked.memories.length, dropped: checked.dropped.length}});
      return {...checked, prompt, raw: text, usage: body?.usage ?? null};
    },
  };

  // Not every model accepts a JSON schema, and the ones that do not reject the
  // whole request rather than ignoring the field. So the schema is an
  // optimisation: ask for it, and fall back to asking in words. That keeps the
  // router working across providers instead of pinning it to one model's
  // feature list.
  async function call(prompt, retry, schema = true) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
          body: JSON.stringify({
            model,
            messages: [{role: 'user', content: schema ? prompt : `${prompt}\n\n${JSON_FALLBACK}`}],
            temperature: 0,
            ...(schema ? {response_format: {type: 'json_schema',
              json_schema: {name: 'memories', strict: true, schema: ROUTER_SCHEMA}}} : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) { throw new RouterError(`router did not respond within ${timeoutMs}ms`, {cause}); }
      // Rate limited: wait once and try again, then give up. Capture missing a
      // turn is the behaviour Satchel had before it existed; retrying in a loop
      // would hold the turn open. What the limit actually says is read rather
      // than guessed, because `x-ratelimit-reset` is a header Google never
      // sends, so every Gemini 429 used to fall through to the 500ms floor.
      if (response.status === 429) {
        const limit = readRateLimit(response, await readFailure(response));
        // A spent daily quota does not come back from a wait, and Google
        // answers one with a ten second retryDelay regardless, so honouring
        // that would hold the turn open and fail anyway. Only a wait that is
        // both short and advised is worth taking.
        const wait = limit.spent ? 0 : Math.min(limit.retryAfterMs || 500, 2000);
        if (retry && wait) {
          await new Promise(done => setTimeout(done, wait));
          return call(prompt, false, schema);
        }
        throw new RouterError(`router is rate limited: ${limit.reason}`,
          {code: 'ROUTER_LIMIT', reason: `capture is rate limited, ${limit.reason}`});
      }
      if (response.status === 400 && schema) return call(prompt, retry, false);
      if (!response.ok) throw new RouterError(`router returned ${response.status}`,
        {code: 'ROUTER_HOST', reason: `the capture model answered ${response.status}`});
      return response.json();
  }
}
