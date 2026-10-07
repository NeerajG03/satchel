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
    new_topic: z.string().nullable().optional()
      .describe('Only when project is a new slug you are naming: one line on what that topic covers. Otherwise null.'),
    expires: z.string().nullable()
      .describe('An ISO date this stops being true, only when the user gave one. Otherwise null.'),
    why: z.string().describe('One short line for the person reading the history later.'),
  })),
});

export const INSTRUCTIONS = localTextFor(CONSOLIDATE_PROMPT);

/** The one question asked when an add lands next to a live memory.
 *
 *  Similarity cannot answer it. On the production embedding two contradicting
 *  claims ("deploys go out Tuesday" against "Thursday") score 0.94, while a
 *  real paraphrase of the same rule scores 0.81 to 0.88. So a twin above the
 *  gate is never affirmed on the number: the same model is asked, about these
 *  two sentences and the words that produced the new one, which of the four
 *  lifecycle answers holds. It is the pass's own decision narrowed to one row,
 *  and it is where extend and replace, which the pass almost never produces on
 *  its own, actually come from. */
export const RECONSIDER_SCHEMA = z.object({
  action: z.enum(['affirm', 'extend', 'replace', 'add'])
    .describe('affirm: the new claim says what the existing one says. extend: it makes the existing one more specific and both stay true. replace: it makes the existing one false. add: they are different claims that both hold.'),
  statement: z.string().describe('For extend, the existing memory reworded to carry the new detail. For replace, the new claim. Empty for affirm and add.'),
  why: z.string().describe('One short line.'),
});

export const RECONSIDER_INSTRUCTIONS = `You keep a person's long-term memory. A pass over one conversation proposed adding a memory, and a memory that already exists is close to it. Decide what the existing memory should become.

- affirm: the new claim says what the existing one says, in other words. Nothing changes but the count.
- extend: the new claim makes the existing one more specific, and both readings stay true. Give the existing memory reworded to carry the detail, nothing dropped.
- replace: the new claim makes the existing one false. Give the new claim. A different day, number, tool or rule for the same thing is a replace, not an extend.
- add: they are about the same thing but are different claims that both hold.

Only the person's own words decide. The quoted source is what they typed; the proposed claim is a pass's reading of it. When the source does not settle it, prefer add over replace, and affirm over extend: a wrong replace ends a memory nobody contradicted.`;

export function buildReconsiderPrompt({proposed, existing, now = new Date()} = {}) {
  const day = value => new Date(value).toISOString().slice(0, 10);
  const lines = [`today is ${day(now)}`, ''];
  lines.push('existing memory');
  lines.push(`  [${existing.kind ?? 'fact'}, ${existing.project_slug ?? (existing.project_id ? 'project' : 'personal')}]  ${String(existing.statement).slice(0, 500)}`);
  lines.push('');
  lines.push('proposed memory');
  lines.push(`  [${proposed.kind}]  ${String(proposed.statement).slice(0, 500)}`);
  lines.push('');
  lines.push('what the person typed, that the proposal came from');
  lines.push(`  "${String(proposed.source).slice(0, 1000)}"`);
  return {system: RECONSIDER_INSTRUCTIONS, prompt: lines.join('\n')};
}

/** One structured call, shared by the pass and the twin question, so a change
 *  to how a fenced answer is salvaged or an error is classified lands once.
 *
 *  A host that ignores the schema request still answers in prose, and a model
 *  told to return JSON sometimes wraps it in a fence. Leniency about the
 *  wrapper only: whatever comes out is parsed against the same schema and
 *  still has to survive validation. Errors leave raw, so the caller can tell
 *  an overloaded host from a bad request, and every caller wraps them before
 *  they reach anyone. */
async function askModel({provider, apiKey, baseURL, fetchImpl, model, thinking, schema, system, prompt, signal, functionId}) {
  try {
    return await generateObject({
      model: providerFor({provider, apiKey, baseURL, fetchImpl}).languageModel(model),
      schema, system, prompt, temperature: 0, abortSignal: signal,
      // Under a provider key, so an OpenAI-shaped host ignores it rather
      // than rejecting the request.
      ...(thinking ? {providerOptions: {google: {thinkingConfig: {thinkingLevel: thinking}}}} : {}),
      // One attempt. A document that was not consolidated this run stays
      // pending and is picked up by the next one, which is a better answer
      // than holding a background job open on a spent quota.
      maxRetries: 0,
      telemetry: {functionId},
    });
  } catch (error) {
    const salvaged = NoObjectGeneratedError.isInstance(error) && salvage(schema, error.text);
    if (!salvaged) throw error;
    return {object: salvaged, usage: error.usage ?? null};
  }
}

/** Two messages, for the same reason the router uses two: the rules are
 *  identical on every call and everything else is a person's own words, so the
 *  boundary between them should be structural rather than a tag.
 *
 *  Both roles of the conversation go in. The assistant's half is what makes
 *  "yes, do that one" readable at all. Only the user's half may supply a
 *  source, and validate() is where that is enforced rather than here. */
export function buildConsolidationPrompt({project = null, projects = [], codebase = null,
  memories = [], turns = [], instructions = INSTRUCTIONS, now = new Date(), cap = 30,
  churn = 25, newTopics = false} = {}) {
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
    lines.push('  project  none linked');
    // Where the talk happened, and which listed projects own that codebase.
    // Several may, and none may: it narrows the choice, it does not make it.
    if (codebase) {
      const owners = projects.filter(p => p.repositories?.includes(codebase)).map(p => p.slug);
      lines.push(`  codebase  ${codebase}${owners.length ? `  (belongs to ${owners.join(', ')})` : ''}`);
    }
    lines.push('');
  }
  const others = projects.filter(p => p.slug !== project?.slug);
  if (others.length) {
    lines.push(project ? 'other projects, only when the user names one'
      : 'projects. If a memory is specific to one of these, use its slug');
    for (const other of others) {
      const repos = other.repositories?.length ? `  repos ${other.repositories.join(', ')}` : '';
      lines.push(`  ${other.slug}  ${(other.brief ?? '').slice(0, 80)}${repos}`.trimEnd());
    }
    lines.push('');
  }
  // Said only when the pass may act on it, so a pass that cannot create a
  // topic is never told it can and then quietly filed into personal.
  if (newTopics) {
    lines.push('new topics are allowed. A fact about a subject of their work that none of the projects above covers can go under a new slug, with new_topic saying what it covers');
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
    // Only what loads into this session counts against the block. A session
    // with no project is shown every project's memories so it can file under
    // one, but only the personal ones load there.
    const loaded = memories.filter(m => !m.project_slug || m.project_slug === project?.slug).length;
    if (loaded >= cap)
      lines.push(`the block holds ${cap} and there are already ${loaded}.`
        + ' Anything you add pushes the weakest line out of context, so add only what is worth'
        + ' more than the weakest line above. Extending costs nothing.');
    else if (loaded >= cap * 0.8)
      lines.push(`the block holds ${cap}. There is not much room left, so prefer extending to adding.`);
    if (loaded >= cap * 0.8) lines.push('');
  } else {
    lines.push('nothing is remembered for this conversation yet');
    lines.push('');
  }
  lines.push('the conversation:');
  lines.push('<conversation>');
  turns.forEach(turn => lines.push(`${turn.role}: ${turn.content}`));
  lines.push('</conversation>');
  return {system: instructions, prompt: lines.join('\n')};
}

/** Two statements are the same claim when they differ only in case,
 *  punctuation or spacing. Deliberately narrow, same as the router's. */
const normalize = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const AGREEMENT = /^\W*(yes|yeah|yep|ok|okay|sure|good|great|fine|correct|right|exactly|agreed|lgtm|sounds good|go ahead|do it|go with (that|it|this)|that one|all good|good as is)[\s\W]*$/i;

/** A yes is still a bare yes when only the assistant's option label follows it,
 *  as in "yes for C4". The label has to be capitals, so "yes for v2" is kept. */
const agreed = source => AGREEMENT.test(source.replace(/\s+(for|on)\s+[A-Z]\d{1,2}[\s\W]*$/, ''));

/** A quote the model stitched from two places with "..." is checked a piece at
 *  a time, and only the start of each piece has to match, same as a whole
 *  quote. One piece has to be long enough to mean something, or "yes ... and"
 *  would match anywhere. */
const quoted = (haystack, source) => {
  const pieces = source.toLowerCase().split(/\.{3}|…/).map(p => p.trim()).filter(Boolean);
  if (pieces.length > 1 && Math.max(...pieces.map(p => p.length)) < 12) return false;
  return pieces.length > 0 && pieces.every(piece => haystack.includes(piece.slice(0, 60)));
};

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
export function validateConsolidation(payload, {turns = [], memories = [], project = null, projects = [], now = new Date(),
  newTopics = false} = {}) {
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
  // New topics the model named, slug to one line. A slug it names twice is one
  // topic, and one that is a near spelling of a listed slug is that slug.
  const topics = new Map();
  const place = (wanted, brief, otherwise) => {
    if (slugs.has(wanted)) return wanted;
    if (!newTopics || typeof wanted !== 'string') return otherwise;
    const slug = wanted.trim().toLowerCase();
    const line = String(brief ?? '').trim();
    if (!SLUG.test(slug) || !line) return otherwise;
    const near = nearSlug(slug, [...slugs, ...topics.keys()]);
    if (near) return near;
    topics.set(slug, line.slice(0, 300));
    return slug;
  };
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
    if (!quoted(haystack, source)) { drop('source is not in the conversation'); continue; }
    // "yes" is in almost every conversation, so it passes the check above
    // while carrying nothing: a claim sourced from it is the assistant's.
    // A retire or an affirm is a yes to something already remembered.
    if (action !== 'retire' && action !== 'affirm' && agreed(source)) { drop('source is only agreement'); continue; }
    // A retire and an affirm change no wording, so neither carries one.
    if (action !== 'retire' && action !== 'affirm') {
      if (!statement || statement.length > 500) { drop('statement missing or too long'); continue; }
    }
    if (action === 'add') {
      if (existing.has(normalize(statement))) { drop('already remembered'); continue; }
      existing.add(normalize(statement));
      changes.push({action, statement, source, kind: change.kind, why: String(change.why ?? '').slice(0, 500),
        project: place(change?.project, change?.new_topic, null), expires: expiry(change?.expires, now)});
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
      // A replacement stays where the claim it replaces lived unless the model
      // names another project. An unlinked session answers null by default,
      // and that must not move a project's fact into every session.
      project: place(change?.project, change?.new_topic, target.project_slug ?? null)});
  }
  // Only the topics a kept change still points at. One named by a change that
  // was then refused would be an empty topic with nothing in it.
  const used = new Set(changes.map(c => c.project));
  return {changes, dropped, topics: [...topics].filter(([slug]) => used.has(slug))
    .map(([slug, brief]) => ({slug, brief}))};
}

/** The same rule the database holds a slug to. */
const SLUG = /^(?=.{3,40}$)[a-z0-9]+(-[a-z0-9]+)*$/;

/** A listed slug that a new one is only a spelling of. Narrow on purpose: the
 *  same words in another order, or one slug's words all inside the other's
 *  ("infra" and "infra-tooling"). Two subjects that merely share a word, like
 *  "email-pacing" and "email-self-serve", stay two. */
export function nearSlug(slug, listed) {
  const words = value => value.split('-').filter(Boolean);
  const mine = new Set(words(slug));
  for (const other of listed) {
    const theirs = new Set(words(other));
    const shared = [...mine].filter(word => theirs.has(word)).length;
    if (shared && (shared === mine.size || shared === theirs.size)) return other;
  }
  return null;
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
    /** One add against one live memory. Same model, a short prompt, a single
     *  attempt: a failure here is answered by the caller adding as proposed,
     *  which is what happened before the question existed. */
    async reconsider({proposed, existing, now = new Date()}, {deadline = null} = {}) {
      if (!apiKey) throw new Error('No router key configured');
      const {system, prompt} = buildReconsiderPrompt({proposed, existing, now});
      const signal = AbortSignal.timeout(
        Math.min(timeoutMs, deadline ? Math.max(1000, deadline - Date.now()) : timeoutMs));
      let result;
      try {
        result = await askModel({provider, apiKey, baseURL, fetchImpl, model, thinking,
          schema: RECONSIDER_SCHEMA, system, prompt, signal, functionId: 'reconsider'});
      } catch (error) { throw asModelError(error, signal, 'consolidation'); }
      const verdict = result.object ?? {};
      const statement = String(verdict.statement ?? '').trim();
      // A verdict that needs a statement and has none, or has one too long
      // for the row, falls back to the safe answer for that direction.
      const held = (verdict.action === 'extend' || verdict.action === 'replace') && (!statement || statement.length > 500);
      const answer = held
        ? {action: 'add', statement: '', why: 'the reworded claim did not hold up'}
        : {action: verdict.action, statement, why: String(verdict.why ?? '').slice(0, 500)};
      // R11: the question and its answer are on the trace, next to the run
      // they belong to, so a replace that ends a memory names what decided it.
      annotate({metadata: {reconsidered: `${answer.action} on ${existing.id ?? 'twin'}`}});
      return {...answer, prompt: `${system}\n\n${prompt}`, raw: JSON.stringify(result.object)};
    },
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
        result = await askModel({provider, apiKey, baseURL, fetchImpl, model, thinking,
          schema: CONSOLIDATION_SCHEMA, system, prompt, signal, functionId: 'consolidate'});
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
        try {
          result = await askModel({provider, apiKey, baseURL, fetchImpl, model, thinking,
            schema: CONSOLIDATION_SCHEMA, system, prompt, signal, functionId: 'consolidate'});
        }
        catch (second) { throw asModelError(second, signal, 'consolidation'); }
      }
      // The generation's usage carries no reasoning count for this provider,
      // so the trace gets it from the SDK, or nobody can tell thinking ran.
      const usage = result.usage ?? {};
      annotate({metadata: {modelUsed: model, waited,
        outputTokens: usage.outputTokens ?? null,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? null}});
      const checked = validateConsolidation(result.object, input);
      return {...checked, model, prompt: `${system}\n\n${prompt}`,
        promptVersion: instructions.version, promptSource: instructions.source,
        raw: JSON.stringify(result.object), usage: result.usage ?? null};
    },
  };
}
