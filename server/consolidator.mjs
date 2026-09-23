// The consolidation pass: one model call over a whole conversation and the
// memories that already exist for it, deciding what the memory set should look
// like now.
//
// This is the thing the Stop router could not be. That call sees a five row
// window and is blind to everything already stored, so its only possible
// output is an INSERT, and "is this durable forever" has to be answered in the
// absolute, from four sentences, by a small model. Both mem0 and supermemory
// separate those two questions, and the separation is the point: what did you
// notice, and what should the store look like now. Satchel fused them into one
// blind call and got 37% precision for it.
//
// What this adds is the second question. Given the document and the current
// memory set, every candidate is one of:
//
//   add          a claim that is not there
//   extend  #n   an existing memory gets more specific, both readings true
//   replace #n   an existing memory is false now
//   retire  #n   an intent has been fulfilled
//   affirm  #n   they said it again, unchanged
//   nothing
//
// `retire` is the one nothing has ever done, and it is what makes "I want
// entries append only" stop being asked for once they are.
//
// Existing memories are shown to the model as integers and mapped back here.
// mem0 does the same thing and comments it as anti-hallucination: a model that
// never sees a UUID cannot invent one.
//
// See docs/memory-v2-5-scope.md, R2, R2a and R5.
import {z} from 'zod';
import {generateObject, NoObjectGeneratedError} from 'ai';
import {providerFor, asBaseUrl, worthWaiting} from './model-provider.mjs';
import {salvage, asModelError} from './router.mjs';
import {consolidatePrompt, localTextFor, CONSOLIDATE_PROMPT} from './prompt-store.mjs';

export const KINDS = ['fact', 'preference', 'intent'];

export const CONSOLIDATION_SCHEMA = z.object({
  changes: z.array(z.object({
    action: z.enum(['add', 'extend', 'replace', 'retire', 'affirm'])
      .describe('add a new memory, extend or replace an existing one, retire a fulfilled intent, or affirm one said again unchanged.'),
    target: z.number().int().nullable()
      .describe('The number of the existing memory this changes. Null for add.'),
    statement: z.string().describe('The claim, written so it still makes sense in six weeks. Empty for retire and affirm.'),
    source: z.string().describe('The words the user actually typed that this came from.'),
    kind: z.enum(['fact', 'preference', 'intent']),
    project: z.string().nullable().describe('A project slug, or null for personal.'),
    expires: z.string().nullable()
      .describe('An ISO date this stops being true, only when the user gave one. Otherwise null.'),
    why: z.string().describe('One short line for the person reading the history later.'),
  })),
});

export const INSTRUCTIONS = localTextFor(CONSOLIDATE_PROMPT);

/** Two messages, for the same reason the router uses two: the rules are
 *  identical on every call and everything else is a person's own words, so the
 *  boundary between them should be structural rather than a tag.
 *
 *  Both roles of the conversation go in. The assistant's half is what makes
 *  "yes, do that one" readable at all. Only the user's half may supply a
 *  source, and validate() is where that is enforced rather than here. */
export function buildConsolidationPrompt({project = null, projects = [],
  memories = [], turns = [], instructions = INSTRUCTIONS, now = new Date(), cap = 30,
  churn = 25} = {}) {
  const lines = [];
  // R7. Nothing had a temporal anchor of any kind, which is how "do not
  // include names of people who are not in the review list this time around"
  // became a permanent personal memory. A model cannot resolve "last week"
  // without being told what week it is, and it cannot doubt a claim without
  // being told how old it is. Both dates are stated, mem0's distinction: when
  // this was said, and when you are reading it.
  const day = value => new Date(value).toISOString().slice(0, 10);
  const spoken = turns.length ? day(turns[0].created_at ?? now) : day(now);
  lines.push(`today is ${day(now)}. this conversation happened on ${spoken}`);
  lines.push('');
  if (project) {
    lines.push('this conversation');
    lines.push(`  project  ${project.slug}  ${(project.brief ?? '').slice(0, 80)}`.trimEnd());
    lines.push('');
  } else {
    lines.push('this conversation');
    lines.push('  project  none, so use null unless the user names one below');
    lines.push('');
  }
  const others = projects.filter(p => p.slug !== project?.slug);
  if (others.length) {
    lines.push('other projects, only when the user names one');
    for (const other of others) lines.push(`  ${other.slug}  ${(other.brief ?? '').slice(0, 80)}`.trimEnd());
    lines.push('');
  }
  // Numbered, and the numbers are the only handle the model gets. A model that
  // never sees an id cannot return one that does not exist.
  if (memories.length) {
    lines.push('memories that already exist. Use the number to change one');
    memories.forEach((memory, index) => {
      const scope = memory.project_slug ?? 'personal';
      const seen = memory.mentions > 1 ? `, said ${memory.mentions} times` : '';
      const last = memory.affirmed_at ?? memory.updated_at;
      const when = last ? `, last on ${day(last)}` : '';
      // R8. The repository moving is the one kind of staleness a conversation
      // never mentions, and it is what made both stale rows in production
      // false. Shown as a fact, not a verdict: the pass decides whether to
      // re-check, and nothing is ended for it.
      const moved = memory.commits_since >= churn ? `, repo +${memory.commits_since} commits since` : '';
      lines.push(`  #${index + 1}  [${memory.kind}, ${scope}${seen}${when}${moved}]  ${String(memory.statement).slice(0, 300)}`);
    });
    lines.push('');
    // R3's comparative pressure, stated only when it is true. The block holds
    // a fixed number and the rest is archive, so past the cap "is this
    // durable" stops being the question and "is this worth more than the
    // weakest line already here" starts being it. That is a judgement a small
    // model can actually make, where the absolute one is what the old 2000
    // word prompt kept getting wrong.
    if (memories.length >= cap)
      lines.push(`the block holds ${cap} and there are already ${memories.length}.`
        + ' Anything you add pushes the weakest line out of context, so add only what is worth'
        + ' more than the weakest line above. Extending costs nothing.');
    else if (memories.length >= cap * 0.8)
      lines.push(`the block holds ${cap}. There is not much room left, so prefer extending to adding.`);
    if (memories.length >= cap * 0.8) lines.push('');
  } else {
    lines.push('nothing is remembered for this conversation yet');
    lines.push('');
  }
  lines.push('the conversation:');
  lines.push('<conversation>');
  for (const turn of turns)
    lines.push(`${turn.role}: ${String(turn.content).slice(0, turn.role === 'assistant' ? 800 : 2000)}`);
  lines.push('</conversation>');
  return {system: instructions, prompt: lines.join('\n')};
}

/** Two statements are the same claim when they differ only in case,
 *  punctuation or spacing. Deliberately narrow, same as the router's. */
const normalize = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A date the user gave, or nothing.
 *
 *  Anything unparseable, already past, or further out than a couple of years
 *  is dropped rather than corrected. A wrong expiry is a memory that
 *  disappears on a day nobody chose, and the harmless failure is the memory
 *  simply not having one. */
function expiry(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  const years = (when.getTime() - now.getTime()) / (365 * 24 * 3600 * 1000);
  return years > 0 && years < 2 ? when.toISOString() : null;
}

/** Everything the model returned that does not hold up, dropped here rather
 *  than reaching the database.
 *
 *  A pass that occasionally changes nothing is the behaviour we already have.
 *  One that invents a memory, or ends one nobody was talking about, is a new
 *  failure and a worse one, because it is destructive. */
export function validateConsolidation(payload, {turns = [], memories = [], project = null, projects = [], now = new Date()} = {}) {
  // Only the user's half. The assistant's words are in the prompt so the model
  // can read the conversation, and a source drawn from them would be the model
  // quoting itself, which is exactly the fabrication this rule exists for.
  const haystack = turns.filter(t => t.role === 'user').map(t => t.content).join('\n').toLowerCase();
  const slugs = new Set([...projects.map(p => p.slug), ...(project ? [project.slug] : [])]);
  const existing = new Set(memories.map(m => normalize(m.statement)));
  const changes = [];
  const dropped = [];
  // One change per existing memory. Two changes to the same row would make the
  // second fail on the revision it no longer has, and the model asking for
  // both usually means it could not decide.
  const touched = new Set();
  for (const change of payload?.changes ?? []) {
    const action = change?.action;
    const statement = String(change?.statement ?? '').trim();
    // memories.source holds 4000 characters, and a model quoting a long paste
    // will quote all of it. Cut, not dropped: only the start has to match.
    const source = String(change?.source ?? '').trim().slice(0, 4000);
    const drop = why => dropped.push({change, why});
    if (!KINDS.includes(change?.kind)) { drop('unknown kind'); continue; }
    // A source is required for every action, retires included. "It is done" is
    // a claim about the world and it has to be something the user actually
    // said, or an intent can be ended by a model's opinion that it looks
    // finished.
    if (!source) { drop('no source'); continue; }
    if (!haystack.includes(source.toLowerCase().slice(0, 60))) { drop('source is not in the conversation'); continue; }
    // A retire and an affirm change no wording, so neither carries one.
    if (action !== 'retire' && action !== 'affirm') {
      if (!statement || statement.length > 500) { drop('statement missing or too long'); continue; }
    }
    if (action === 'add') {
      if (existing.has(normalize(statement))) { drop('already remembered'); continue; }
      existing.add(normalize(statement));
      changes.push({action, statement, source, kind: change.kind, why: String(change.why ?? '').slice(0, 500),
        project: slugs.has(change?.project) ? change.project : null, expires: expiry(change?.expires, now)});
      continue;
    }
    const target = memories[Number(change?.target) - 1];
    if (!target) { drop('no such memory'); continue; }
    if (touched.has(target.id)) { drop('already changed in this run'); continue; }
    // R2a. A completion ends an intent. It does not end a standing fact,
    // because a fact is not a thing anyone finishes, and letting a "that's
    // done" retire one would quietly delete the most durable rows in the set.
    if (action === 'retire' && target.kind !== 'intent') { drop('only an intent can be retired'); continue; }
    touched.add(target.id);
    changes.push({action, target: target.id, revision: target.revision,
      statement: action === 'retire' || action === 'affirm' ? '' : statement, source, kind: change.kind,
      why: String(change.why ?? '').slice(0, 500),
      project: slugs.has(change?.project) ? change.project : null});
  }
  return {changes, dropped};
}

export function createConsolidator({
  // One capable call rather than a dozen cheap ones, and this is the call
  // that pattern was for. The turn router made one cheap call per turn and
  // could only ever ask "is this durable"; this makes one call per session
  // and asks what the memory set should be, against everything already in
  // it. A session's worth of budget in a single call buys a better model.
  //
  // Not measured yet. eval/router.mjs covers the router prompt and there is
  // no eval for this one, which is the honest gap in the whole rebuild.
  model = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.8-flash',
  // Medium. Deciding between add, extend, replace, retire and nothing, over
  // a numbered list, with rules about which kinds may be retired, is a
  // reasoning problem. It is also the call whose mistakes are destructive,
  // which is the other reason to pay for thought here.
  thinking = process.env.SATCHEL_THINKING_LEVEL ?? 'medium',
  provider = process.env.SATCHEL_ROUTER_PROVIDER ?? 'google',
  baseURL = asBaseUrl(process.env.SATCHEL_ROUTER_URL),
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY,
  // A whole session read by a thinking model, and nothing waiting on it: this
  // runs after the conversation has ended. The ceiling that matters is not
  // this one but the function's, which is why consolidatePending keeps its
  // own clock and stops starting documents it cannot finish.
  timeoutMs = Number(process.env.SATCHEL_CONSOLIDATE_TIMEOUT_MS ?? 40000),
  promptResolver = consolidatePrompt,
  annotate = () => {},
  // How long to wait before asking the same model again, once, after it
  // could not answer. Two minutes, because the 503s this is for cleared in
  // seconds and a wait that long outlasts most of them, and because a longer
  // one would not fit in a job step with a call after it.
  retryAfterMs = Number(process.env.SATCHEL_CONSOLIDATE_RETRY_MS ?? 120_000),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  fetchImpl = fetch,
} = {}) {
  return {
    model,
    timeoutMs,
    retryAfterMs,
    /** `deadline` is the wall the caller has to finish behind, which is the
     *  serverless function's own limit rather than anything about the model.
     *  Bounding the call by whichever comes first is what keeps a batch from
     *  being killed mid-write: a run that gives up has decided nothing and
     *  leaves the document pending, and a run that is killed may have written
     *  half of what it decided. */
    async consolidate(input, {deadline = null} = {}) {
      if (!apiKey) throw new Error('No router key configured');
      const instructions = await promptResolver();
      const {system, prompt} = buildConsolidationPrompt({...input, instructions: instructions.text});
      // A fresh clock for each attempt, bounded by whatever the caller has
      // left: the second one starts two minutes after the first.
      const attempt = () => AbortSignal.timeout(
        Math.min(timeoutMs, deadline ? Math.max(1000, deadline - Date.now()) : timeoutMs));
      // R11. A run nobody watches is only auditable if the trace says what it
      // was looking at before it says what it did.
      annotate({metadata: {
        promptName: CONSOLIDATE_PROMPT,
        thinking: thinking || 'off',
        promptSource: instructions.source,
        promptVersion: instructions.version ?? 'file',
        scope: input.project?.slug ?? 'personal',
        knownMemories: input.memories?.length ?? 0,
        turns: input.turns?.length ?? 0,
        characters: (input.turns ?? []).reduce((sum, t) => sum + String(t.content ?? '').length, 0),
      }});
      let result;
      let signal = attempt();
      let waited = false;
      try {
        result = await ask(model, signal);
      } catch (error) {
        // The same model, once more, after a wait. Never a different one: a
        // session a weaker model read is marked as read and not looked at
        // again, and one left pending is read properly by the next pass.
        const failure = asModelError(error, signal, 'consolidation');
        if (!worthWaiting(failure)) throw failure;
        // Only when there is room for the wait and a whole call after it.
        // Otherwise the caller hears `later`, and a job hands the session to
        // its next step, which starts with a full clock.
        if (deadline && deadline - Date.now() < retryAfterMs + timeoutMs) throw Object.assign(failure, {later: true});
        await sleep(retryAfterMs);
        waited = true;
        signal = attempt();
        try { result = await ask(model, signal); }
        catch (second) { throw asModelError(second, signal, 'consolidation'); }
      }
      annotate({metadata: {modelUsed: model, waited}});
      const checked = validateConsolidation(result.object, input);
      return {...checked, model, prompt: `${system}\n\n${prompt}`,
        promptVersion: instructions.version, promptSource: instructions.source,
        raw: JSON.stringify(result.object), usage: result.usage ?? null};

      async function ask(which, signal) {
      let result;
      try {
        result = await generateObject({
          model: providerFor({provider, apiKey, baseURL, fetchImpl}).languageModel(which),
          schema: CONSOLIDATION_SCHEMA,
          system, prompt, temperature: 0, abortSignal: signal,
          // Under a provider key, so an OpenAI-shaped host ignores it rather
          // than rejecting the request.
          ...(thinking ? {providerOptions: {google: {thinkingConfig: {thinkingLevel: thinking}}}} : {}),
          // One attempt. A document that was not consolidated this run stays
          // pending and is picked up by the next one, which is a better answer
          // than holding a background job open on a spent quota.
          maxRetries: 0,
          telemetry: {functionId: 'consolidate'},
        });
      } catch (error) {
        // A host that ignores the schema request still answers in prose, and
        // a model told to return JSON sometimes wraps it in a fence. Leniency
        // about the wrapper only: whatever comes out is parsed against the
        // same schema and still has to survive validation.
        const salvaged = NoObjectGeneratedError.isInstance(error) && salvage(CONSOLIDATION_SCHEMA, error.text);
        // Raw, so the caller can tell an overloaded host from a bad request.
        // Every path out of consolidate() wraps it before it reaches anyone.
        if (!salvaged) throw error;
        result = {object: salvaged, usage: error.usage ?? null};
      }
      return result;
      }
    },
  };
}
