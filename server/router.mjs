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
import {capturePrompt, localText, CAPTURE_PROMPT} from './prompt-store.mjs';

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
  })),
});

// The instructions are no longer written here. They live in Langfuse, versioned
// and labelled, with server/prompts/capture-router.md as the editing surface
// and the fallback. See prompt-store.mjs for why.
//
// This is the fallback text, and it is also what buildPrompt() uses when no
// instructions are handed to it, so every test and every offline caller gets
// the committed wording rather than whatever a network call returned.
export const INSTRUCTIONS = localText;

/** Two messages, not one.
 *
 *  Everything was a single user message: the instructions, the project list,
 *  the earlier context and the user's own words, separated from the rules only
 *  by a <turn> tag. The stable half is identical on every call and
 *  the rest is different every time, so splitting them makes the boundary
 *  between "rules" and "text a person typed" structural rather than a tag,
 *  which is the right shape for something whose entire input is untrusted.
 *
 *  Context is for understanding only; only the turn being classified can supply
 *  a source. */
export function buildPrompt({codebase = null, project = null, projects = [],
  context = [], turn = [], saved = [],
  // The wording Langfuse is serving, when there is one. Defaulting to the
  // committed copy keeps this function synchronous and keeps every test
  // measuring the text in the repository.
  instructions = INSTRUCTIONS} = {}) {
  const lines = [];
  const table = (rows, first) => {
    const width = Math.max(...rows.map(r => String(r[first] ?? '').length));
    for (const row of rows) lines.push(`  ${String(row[first] ?? '').padEnd(width)}  ${row.detail}`.trimEnd());
  };
  // The one fact that was missing, and the whole reason a memory about this
  // project's own deployment key landed in personal. The model had a flat list
  // of every project and nothing saying which one the conversation was in, so
  // it had to infer the scope from the words, and the words did not say.
  if (codebase || project) {
    lines.push('working on');
    if (codebase) lines.push(`  codebase  ${codebase}`);
    // Named separately from the others so "the project this codebase belongs
    // to" stays a narrower question than "one of all your projects". When a
    // repository may belong to several projects this becomes two or three
    // lines and nothing else about the prompt changes.
    if (project) lines.push(`  project   ${project.slug}  ${(project.brief ?? '').slice(0, 80)}`.trimEnd());
    else lines.push('  project   none selected, so use null unless the user names a project below');
    lines.push('');
  }
  const others = projects.filter(p => p.slug !== project?.slug);
  if (others.length) {
    lines.push('other projects, only when the user names one');
    table(others.map(p => ({slug: p.slug, detail: (p.brief ?? '').slice(0, 80)})), 'slug');
    lines.push('');
  }
  // The open task list used to go here, because the model picked a task slug
  // for each item. A memory has one scope now and it is a project or personal,
  // so there is nothing to pick, and a list of work in progress in front of a
  // model deciding what is durable pulls in exactly the wrong direction.
  // A second guard behind the turn boundary. The boundary stops the same
  // message being classified twice; this stops the same claim being saved twice
  // when the user says it again in their own different words.
  if (saved.length) {
    lines.push('already saved in this session, do not save any of these again');
    for (const statement of saved) lines.push(`  ${String(statement).slice(0, 200)}`);
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
  return {system: instructions, prompt: lines.join('\n')};
}

/** Everything the model returned that does not hold up is dropped here rather
 *  than reaching the database. A router that occasionally says nothing is the
 *  behaviour we already have; one that invents is a new failure. */
export function validate(payload, {turn = [], project = null, projects = [], saved = []}) {
  const haystack = turn.join('\n').toLowerCase();
  // The active project is nameable too. It is not in `projects` when the caller
  // passes the others separately, and a model told to default to it would have
  // every item dropped back to personal by this check, which is the bug being
  // fixed wearing a different hat.
  const projectSlugs = new Set([...projects.map(p => p.slug), ...(project ? [project.slug] : [])]);
  const already = new Set(saved.map(normalizeStatement));
  const kept = [];
  const dropped = [];
  for (const item of payload?.memories ?? []) {
    const statement = String(item?.statement ?? '').trim();
    // memories.source holds 4000 characters, and a model quoting a long paste
    // will quote all of it. Cut, not dropped: only the start has to match.
    const source = String(item?.source ?? '').trim().slice(0, 4000);
    if (!statement || statement.length > 500) { dropped.push({item, why: 'statement missing or too long'}); continue; }
    if (!source) { dropped.push({item, why: 'no source'}); continue; }
    // The prompt asks for these to be left out and mostly they are. This is the
    // backstop for the wording the prompt did not talk it out of, and it only
    // catches a near-identical restatement: the semantic work stays in the
    // prompt, because doing it here would need an embedding per candidate and
    // the quota that pays for embeddings is the one retrieval runs on.
    if (already.has(normalizeStatement(statement))) { dropped.push({item, why: 'already saved this session'}); continue; }
    // The source has to be in what the user typed this turn. This is the check
    // that makes fabrication detectable rather than a matter of trust.
    if (!haystack.includes(source.toLowerCase().slice(0, 60))) {
      dropped.push({item, why: 'source is not in the turn'});
      continue;
    }
    // One scope, and only one the caller already named. The line this
    // replaced was `project: task ? taskProject : project`, so a wrong task
    // guess silently moved a memory into another project.
    kept.push({statement, source, project: projectSlugs.has(item?.project) ? item.project : null});
  }
  return {memories: kept, dropped};
}

/** Two statements are the same claim for dedup purposes when they differ only
 *  in case, punctuation or spacing. Deliberately narrow. */
const normalizeStatement = text =>
  String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function createRouter({
  // One capable call rather than a dozen cheap ones. Capture used to run at
  // the end of every turn, so the model had to be the cheapest thing that
  // worked, and gemini-3.5-flash-lite was measured at 22 of 24 extracted and
  // quiet on all 16 negatives, at about 1.6 seconds. See eval/router.mjs.
  //
  // That measurement described a design where n calls happened per session.
  // A session is now one call, so the budget per call went up by roughly the
  // length of the session and the model moves with it.
  //
  // The eval has not been re-run against this model. The numbers above are
  // the old model's and they are left in place as the thing to beat rather
  // than as a description of what ships.
  //
  // Pinned rather than -latest on purpose: a floating alias would move the
  // thing a measurement describes, silently, between two runs of it.
  model = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.8-flash',
  // Medium. This is a judgement over a list with a rule about what not to
  // keep, which is exactly the shape thinking helps with, and the failure it
  // is meant to prevent, a work order stored as a durable claim, is a
  // reasoning failure rather than a knowledge one.
  thinking = process.env.SATCHEL_THINKING_LEVEL ?? 'medium',
  // Google natively, so the provider enforces the schema instead of being
  // asked to follow one. Any OpenAI-shaped host is `openai` plus a url.
  provider = process.env.SATCHEL_ROUTER_PROVIDER ?? 'google',
  baseURL = asBaseUrl(process.env.SATCHEL_ROUTER_URL),
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY,
  // Longer than the 8 seconds a non-thinking model needed. A budget tuned for
  // a model that answers immediately turns a slower, better one into a
  // timeout, which reads as "capture is broken" rather than "capture is
  // thinking".
  timeoutMs = Number(process.env.SATCHEL_ROUTER_TIMEOUT_MS ?? 20000),
  // Where the instructions come from. Injected so the eval can hold one
  // wording against another through this exact code path, rather than
  // measuring a copy of the prompt that has drifted from the one shipped.
  promptResolver = capturePrompt,
  // How the router says what it was looking at. Injected rather than imported
  // for the same reason `traced` is: tracing.mjs pulls in the OpenTelemetry
  // node SDK, and the eval and the tests run this file without any of it.
  annotate = () => {},
  fetchImpl = fetch,
} = {}) {
  return {
    model,
    async route(input) {
      if (!apiKey) throw new RouterError('No router key configured');
      // Resolved before the model call, not at import: the label can be moved
      // in Langfuse to roll a wording back without a deploy, and a warm
      // instance that never re-reads it would keep serving the old one for as
      // long as it lives. This cannot fail the capture; the worst case is the
      // committed file.
      const instructions = await promptResolver();
      const {system, prompt} = buildPrompt({...input, instructions: instructions.text});
      let lastSignal;
      // One retry, on a short advised wait only. Capture missing a turn is the
      // behaviour Satchel had before capture existed, so a loop here would
      // hold the turn open for no gain, and a spent daily quota does not come
      // back from waiting at all. The SDK's own maxRetries is 0 precisely so
      // this stays a decision made with the 429 body in hand.
      for (let attempt = 0; ; attempt++) {
        try { return await ask(); }
        catch (error) {
          const failure = asModelError(error, lastSignal);
          const wait = failure.code === 'ROUTER_LIMIT' && !failure.spent ? failure.retryAfterMs || 500 : 0;
          if (attempt > 0 || !wait || wait > 2000) throw failure;
          await new Promise(done => setTimeout(done, wait));
        }
      }

      async function ask() {
      const signal = lastSignal = AbortSignal.timeout(timeoutMs);
      // What the router was looking at, on the trace that already groups this
      // capture. A capture is only explicable if you can see the scope it was
      // handed and the wording it was given: without the version, a trace from
      // before a prompt change and one from after are indistinguishable, which
      // makes the whole exercise unmeasurable after the fact.
      annotate({metadata: {
        codebase: input.codebase ?? 'none',
        thinking: thinking || 'off',
        promptName: CAPTURE_PROMPT,
        promptSource: instructions.source,
        promptVersion: instructions.version ?? 'file',
        // The scope the router was handed, which is the thing to look at first
        // when something files itself in the wrong place.
        workingOn: input.project?.slug ?? 'personal',
        projects: input.projects?.length ?? 0,
        alreadySaved: input.saved?.length ?? 0,
        contextMessages: input.context?.length ?? 0,
        turnMessages: input.turn?.length ?? 0,
      }});
      let result;
      try {
        result = await generateObject({
          model: providerFor({provider, apiKey, baseURL, fetchImpl}).languageModel(model),
          schema: ROUTER_SCHEMA,
          system,
          prompt,
          temperature: 0,
          abortSignal: signal,
          // Ignored by every host that is not Google, which is the point of
          // putting it under a provider key: an OpenAI-shaped endpoint stays
          // a change of two environment variables rather than of code.
          ...(thinking ? {providerOptions: {google: {thinkingConfig: {thinkingLevel: thinking}}}} : {}),
          // One attempt. Capture missing a turn is the behaviour Satchel had
          // before capture existed; the SDK's default of two retries with
          // backoff would hold the turn open to learn what the 429 body
          // already said.
          maxRetries: 0,
          // functionId is all the SDK carries for us. It named a `metadata`
          // bag too, and everything below used to live in it, but v7 reads
          // per-call metadata off `runtimeContext` and generateObject does not
          // take one, so the bag arrived nowhere and no attribute was ever
          // written. It looked like it worked, which is the worst version of
          // not working. The same facts go on the surrounding trace instead,
          // just above.
          telemetry: {functionId: 'router'},
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
        const salvaged = NoObjectGeneratedError.isInstance(error) && salvage(ROUTER_SCHEMA, error.text);
        if (!salvaged) throw asModelError(error, signal);
        result = {object: salvaged, usage: error.usage ?? null};
      }
      // Everything the model returned still goes through validate(). The schema
      // guarantees the shape; only validate() can check that a source is really
      // in what the user typed, which is what makes fabrication detectable
      // rather than a matter of trust.
      const checked = validate(result.object, input);
      return {...checked, prompt: `${system}\n\n${prompt}`,
        promptVersion: instructions.version, promptSource: instructions.source,
        raw: JSON.stringify(result.object), usage: result.usage ?? null};
      }
    },
  };
}

/** Pulls an object out of a reply that carries one but is not one. Returns
 *  null rather than throwing, so the caller reports the original failure.
 *
 *  Exported because the consolidation pass asks a model the same way and needs
 *  the same leniency about wrappers, and only about wrappers: whatever comes
 *  out is still parsed against the schema it was given. */
export function salvage(schema, text) {
  if (typeof text !== 'string') return null;
  const attempts = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1]);
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const attempt of attempts) {
    const parsed = schema.safeParse((() => {
      try { return JSON.parse(attempt.trim()); } catch { return null; }
    })());
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** Turns an SDK failure into something the hook can say out loud. These carry
 *  no Postgres code, so without a `reason` they all land on the default branch
 *  of errorText and reach the person as "Satchel request failed. Reload before
 *  retrying a write: it may have completed", which is wrong twice over.
 *
 *  `noun` is what the person is told went wrong. Two small model calls exist
 *  now and "capture is rate limited" would be a lie about the other one. */
export function asModelError(error, signal, noun = 'capture') {
  if (error instanceof RouterError) return error;
  if (NoObjectGeneratedError.isInstance(error))
    return new RouterError('router returned nothing matching the schema',
      {cause: error, code: 'ROUTER_SHAPE', reason: `the ${noun} model returned nothing usable`});
  const {kind, status} = describeFailure(error, signal);
  if (kind === 'timeout')
    return new RouterError(`router did not respond within its timeout`,
      {cause: error, code: 'ROUTER_TIMEOUT', reason: `the ${noun} model did not answer in time`});
  if (kind === 'shape')
    return new RouterError('router returned a response that is not usable',
      {cause: error, code: 'ROUTER_SHAPE', reason: `the ${noun} model returned nothing usable`});
  // The status travels. `host` covers everything from 400 up, and the
  // difference between 400 and 503 decides whether asking a different model
  // is worth anything: a bad request is refused identically everywhere.
  if (kind === 'host')
    return Object.assign(
      new RouterError(`router returned ${status}`,
        {cause: error, code: 'ROUTER_HOST', reason: `the ${noun} model answered ${status}`}),
      {status});
  // What the limit says is read rather than guessed. A spent daily quota comes
  // back with a ten second retryDelay that reads exactly like a burst limit, so
  // the reason has to name which one it was or every 429 looks transient.
  const limit = readApiFailure(error);
  return Object.assign(
    new RouterError(`router is rate limited: ${limit.reason}`,
      {cause: error, code: 'ROUTER_LIMIT', reason: `${noun} is rate limited, ${limit.reason}`}),
    // Read by the single retry above: a spent day and a burst need opposite
    // answers and the status code cannot tell them apart.
    {spent: limit.spent, retryAfterMs: limit.retryAfterMs});
}
