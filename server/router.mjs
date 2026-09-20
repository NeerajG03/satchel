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

export class RouterError extends Error {
  constructor(message, {cause} = {}) { super(message); this.name = 'RouterError'; this.cause = cause; }
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

Return a list. Most turns return an empty list, and that is the correct answer. Do not fill the list to seem useful.

Keep something when the user states a preference, a decision, a constraint, or a durable fact about their work or their life. Something that would still be true and still be useful in six weeks.

Do not keep:
- what the assistant said or suggested. Only the user's own claims.
- anything about the current moment: what is open, what is running, what failed just now, what you are about to do.
- a question, or thinking out loud that the user did not land on.
- something already obvious from the project list.

For each thing you keep:
- "statement" is the claim written clearly. Fix grammar, drop filler, resolve a pronoun whose referent is in this window, and keep the user's own vocabulary. Do not add a reason they did not give, do not widen it, and do not merge two separate claims into one.
- "source" must be text the user actually typed in the turn being classified. Copy it. If you cannot point at the words, do not keep the item.
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
  // A full URL, so any OpenAI-compatible host works without a code change.
  // Google's compatibility layer is
  // https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
  model = process.env.SATCHEL_ROUTER_MODEL ?? 'google/gemma-4-26b-a4b-it:free',
  url = process.env.SATCHEL_ROUTER_URL ?? 'https://openrouter.ai/api/v1/chat/completions',
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.OPENROUTER_API_KEY,
  timeoutMs = Number(process.env.SATCHEL_ROUTER_TIMEOUT_MS ?? 8000),
  fetchImpl = fetch,
} = {}) {
  return {
    model,
    async route(input) {
      if (!apiKey) throw new RouterError('No router key configured');
      const prompt = buildPrompt(input);
      const body = await call(prompt, true);
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new RouterError('router returned no content');
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (cause) { throw new RouterError('router returned content that is not JSON', {cause}); }
      return {...validate(parsed, input), prompt, raw: text, usage: body?.usage ?? null};
    },
  };

  async function call(prompt, retry) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
          body: JSON.stringify({
            model,
            messages: [{role: 'user', content: prompt}],
            temperature: 0,
            response_format: {type: 'json_schema', json_schema: {name: 'memories', strict: true, schema: ROUTER_SCHEMA}},
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) { throw new RouterError(`router did not respond within ${timeoutMs}ms`, {cause}); }
      // Rate limited: wait once and try again, then give up. Capture missing a
      // turn is the behaviour Satchel had before it existed; retrying in a loop
      // would hold the turn open.
      if (response.status === 429 && retry) {
        const reset = Number(response.headers?.get?.('x-ratelimit-reset')) || 0;
        await new Promise(done => setTimeout(done, Math.min(Math.max(reset - Date.now(), 500), 2000)));
        return call(prompt, false);
      }
      if (!response.ok) throw new RouterError(`router returned ${response.status}`);
      return response.json();
  }
}
