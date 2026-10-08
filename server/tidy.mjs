// The tidy: one call a night over the topics and what sits in personal.
//
// Consolidation files a new fact as it arrives. It cannot fix what was filed
// before topics existed, and it cannot see that two topics it made on two
// nights are one subject. This is the call that looks at the whole set at once
// and says what should move and what should merge. The database does the
// moving, inside the same grant every other write goes through.
import {z} from 'zod';
import {askModel, nearSlug} from './consolidator.mjs';
import {asBaseUrl} from './model-provider.mjs';
import {asModelError} from './router.mjs';
import {tidyPrompt, localTextFor, TIDY_PROMPT} from './prompt-store.mjs';

export const TIDY_SCHEMA = z.object({
  moves: z.array(z.object({
    memory: z.number().int().describe('The number of the personal memory to move.'),
    topic: z.string().describe('The slug it goes to.'),
    new_topic: z.string().nullable().optional()
      .describe('Only when topic is a slug you are naming: one line on what it covers. Otherwise null.'),
    why: z.string(),
  })),
  merges: z.array(z.object({
    from: z.string().describe('The slug that goes away. Only one made by Satchel.'),
    into: z.string().describe('The slug it joins.'),
    why: z.string(),
  })),
});

export const INSTRUCTIONS = localTextFor(TIDY_PROMPT);

/** The same rule the database holds a slug to. */
const SLUG = /^(?=.{3,40}$)[a-z0-9]+(-[a-z0-9]+)*$/;

export function buildTidyPrompt({topics = [], memories = [], instructions = INSTRUCTIONS} = {}) {
  const lines = ['topics'];
  if (!topics.length) lines.push('  none yet');
  for (const topic of topics) {
    const mark = topic.made_by === 'satchel' ? '  [made by Satchel]' : '';
    lines.push(`  ${topic.slug}  ${String(topic.brief ?? '').slice(0, 120)}${mark}`.trimEnd());
  }
  lines.push('');
  lines.push('memories in personal');
  if (!memories.length) lines.push('  none');
  memories.forEach((memory, index) =>
    lines.push(`  #${index + 1}  [${memory.kind ?? 'fact'}]  ${String(memory.statement).slice(0, 300)}`));
  return {system: instructions, prompt: lines.join('\n')};
}

/** What holds up, mapped back to rows. A move to a slug that is a near spelling
 *  of a listed one goes to that one, and a new slug named twice is one topic. */
export function validateTidy(payload, {topics = [], memories = []} = {}) {
  const bySlug = new Map(topics.map(t => [t.slug, t]));
  const fresh = new Map();
  const moves = [], merges = [], dropped = [];
  const seen = new Set();
  for (const move of payload?.moves ?? []) {
    const memory = memories[Number(move?.memory) - 1];
    if (!memory) { dropped.push({move, why: 'no such memory'}); continue; }
    if (seen.has(memory.id)) { dropped.push({move, why: 'already moved'}); continue; }
    let slug = String(move?.topic ?? '').trim().toLowerCase();
    if (!bySlug.has(slug)) {
      const near = nearSlug(slug, [...bySlug.keys(), ...fresh.keys()]);
      if (near) slug = near;
      else {
        const brief = String(move?.new_topic ?? '').trim();
        if (!SLUG.test(slug) || !brief) { dropped.push({move, why: 'new topic without a valid slug and a line'}); continue; }
        fresh.set(slug, brief.slice(0, 300));
      }
    }
    seen.add(memory.id);
    moves.push({memory, slug, why: String(move?.why ?? '').slice(0, 500)});
  }
  const gone = new Set();
  for (const merge of payload?.merges ?? []) {
    const from = bySlug.get(merge?.from), into = bySlug.get(merge?.into);
    if (!from || !into || from.slug === into.slug) { dropped.push({merge, why: 'not two listed topics'}); continue; }
    if (from.made_by !== 'satchel') { dropped.push({merge, why: 'only a topic Satchel made is merged away'}); continue; }
    if (gone.has(from.slug) || gone.has(into.slug)) { dropped.push({merge, why: 'already in a merge'}); continue; }
    gone.add(from.slug);
    merges.push({from, into, why: String(merge?.why ?? '').slice(0, 500)});
  }
  // A move into a topic merged away in the same answer goes where it went.
  for (const move of moves) {
    const merge = merges.find(m => m.from.slug === move.slug);
    if (merge) move.slug = merge.into.slug;
  }
  const used = new Set(moves.map(m => m.slug));
  return {moves, merges, dropped,
    topics: [...fresh].filter(([slug]) => used.has(slug)).map(([slug, brief]) => ({slug, brief}))};
}

export function createTidier({
  model = process.env.SATCHEL_ROUTER_MODEL ?? 'gemini-3.8-flash',
  thinking = process.env.SATCHEL_THINKING_LEVEL ?? 'medium',
  provider = process.env.SATCHEL_ROUTER_PROVIDER ?? 'google',
  baseURL = asBaseUrl(process.env.SATCHEL_ROUTER_URL),
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY,
  timeoutMs = Number(process.env.SATCHEL_CONSOLIDATE_TIMEOUT_MS ?? 40000),
  promptResolver = tidyPrompt,
  fetchImpl = fetch,
} = {}) {
  return {
    model,
    async tidy(input, {deadline = null} = {}) {
      if (!apiKey) throw new Error('No router key configured');
      const instructions = await promptResolver();
      const {system, prompt} = buildTidyPrompt({...input, instructions: instructions.text});
      const signal = AbortSignal.timeout(
        Math.min(timeoutMs, deadline ? Math.max(1000, deadline - Date.now()) : timeoutMs));
      let result;
      try {
        result = await askModel({provider, apiKey, baseURL, fetchImpl, model, thinking,
          schema: TIDY_SCHEMA, system, prompt, signal, functionId: 'tidy'});
      } catch (error) { throw asModelError(error, signal, 'tidy'); }
      return {...validateTidy(result.object, input), model, prompt: `${system}\n\n${prompt}`,
        raw: JSON.stringify(result.object), usage: result.usage ?? null,
        promptSource: instructions.source};
    },
  };
}
