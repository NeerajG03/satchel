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
import {providerFor, asBaseUrl} from './model-provider.mjs';
import {salvage, asModelError} from './router.mjs';
import {consolidatePrompt, localTextFor, CONSOLIDATE_PROMPT} from './prompt-store.mjs';

export const KINDS = ['fact', 'preference', 'intent'];

export const CONSOLIDATION_SCHEMA = z.object({
  changes: z.array(z.object({
    action: z.enum(['add', 'extend', 'replace', 'retire'])
      .describe('add a new memory, extend or replace an existing one, or retire a fulfilled intent.'),
    target: z.number().int().nullable()
      .describe('The number of the existing memory this changes. Null for add.'),
    statement: z.string().describe('The claim, written so it still makes sense in six weeks. Empty for retire.'),
    source: z.string().describe('The words the user actually typed that this came from.'),
    kind: z.enum(['fact', 'preference', 'intent']),
    project: z.string().nullable().describe('A project slug, or null for personal.'),
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
  memories = [], turns = [], instructions = INSTRUCTIONS} = {}) {
  const lines = [];
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
      lines.push(`  #${index + 1}  [${memory.kind}, ${scope}${seen}]  ${String(memory.statement).slice(0, 300)}`);
    });
    lines.push('');
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

/** Everything the model returned that does not hold up, dropped here rather
 *  than reaching the database.
 *
 *  A pass that occasionally changes nothing is the behaviour we already have.
 *  One that invents a memory, or ends one nobody was talking about, is a new
 *  failure and a worse one, because it is destructive. */
export function validateConsolidation(payload, {turns = [], memories = [], project = null, projects = []} = {}) {
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
    const source = String(change?.source ?? '').trim();
    const drop = why => dropped.push({change, why});
    if (!KINDS.includes(change?.kind)) { drop('unknown kind'); continue; }
    // A source is required for every action, retires included. "It is done" is
    // a claim about the world and it has to be something the user actually
    // said, or an intent can be ended by a model's opinion that it looks
    // finished.
    if (!source) { drop('no source'); continue; }
    if (!haystack.includes(source.toLowerCase().slice(0, 60))) { drop('source is not in the conversation'); continue; }
    if (action !== 'retire') {
      if (!statement || statement.length > 500) { drop('statement missing or too long'); continue; }
    }
    if (action === 'add') {
      if (existing.has(normalize(statement))) { drop('already remembered'); continue; }
      existing.add(normalize(statement));
      changes.push({action, statement, source, kind: change.kind, why: String(change.why ?? '').slice(0, 500),
        project: slugs.has(change?.project) ? change.project : null});
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
      statement: action === 'retire' ? '' : statement, source, kind: change.kind,
      why: String(change.why ?? '').slice(0, 500),
      project: slugs.has(change?.project) ? change.project : null});
  }
  return {changes, dropped};
}

export function createConsolidator({
  // The same small model the router runs on, for the same reason: this is a
  // comparative judgement over a list, not a hard one, and the measurement
  // that picked it is in eval/router.mjs.
  model = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.5-flash-lite',
  provider = process.env.SATCHEL_ROUTER_PROVIDER ?? 'google',
  baseURL = asBaseUrl(process.env.SATCHEL_ROUTER_URL),
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY,
  // Longer than the router's 8 seconds. This reads a whole session rather than
  // a five row window, and nothing is waiting on it: it runs in the
  // background, after the conversation has ended.
  timeoutMs = Number(process.env.SATCHEL_CONSOLIDATE_TIMEOUT_MS ?? 30000),
  promptResolver = consolidatePrompt,
  annotate = () => {},
  fetchImpl = fetch,
} = {}) {
  return {
    model,
    async consolidate(input) {
      if (!apiKey) throw new Error('No router key configured');
      const instructions = await promptResolver();
      const {system, prompt} = buildConsolidationPrompt({...input, instructions: instructions.text});
      const signal = AbortSignal.timeout(timeoutMs);
      // R11. A run nobody watches is only auditable if the trace says what it
      // was looking at before it says what it did.
      annotate({metadata: {
        promptName: CONSOLIDATE_PROMPT,
        promptSource: instructions.source,
        promptVersion: instructions.version ?? 'file',
        scope: input.project?.slug ?? 'personal',
        knownMemories: input.memories?.length ?? 0,
        turns: input.turns?.length ?? 0,
        characters: (input.turns ?? []).reduce((sum, t) => sum + String(t.content ?? '').length, 0),
      }});
      let result;
      try {
        result = await generateObject({
          model: providerFor({provider, apiKey, baseURL, fetchImpl}).languageModel(model),
          schema: CONSOLIDATION_SCHEMA,
          system, prompt, temperature: 0, abortSignal: signal,
          // One attempt. A document that was not consolidated this run stays
          // pending and is picked up by the next one, which is a better answer
          // than holding a background job open on a spent quota.
          maxRetries: 0,
          telemetry: {functionId: 'consolidate'},
        });
      } catch (error) {
        const salvaged = NoObjectGeneratedError.isInstance(error) && salvage(CONSOLIDATION_SCHEMA, error.text);
        if (!salvaged) throw asModelError(error, signal, 'consolidation');
        result = {object: salvaged, usage: error.usage ?? null};
      }
      const checked = validateConsolidation(result.object, input);
      return {...checked, prompt: `${system}\n\n${prompt}`,
        promptVersion: instructions.version, promptSource: instructions.source,
        raw: JSON.stringify(result.object), usage: result.usage ?? null};
    },
  };
}
