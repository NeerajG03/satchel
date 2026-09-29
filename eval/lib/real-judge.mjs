// Second look at what keywords could not settle: which of the pass's claims
// say the same thing as which memories a labeller wrote down. One model call
// per session, and only for sessions with something unmatched on both sides.
import {z} from 'zod';
import {generateObject} from 'ai';
import {providerFor} from '../../server/model-provider.mjs';

const SCHEMA = z.object({matches: z.array(z.object({
  gold: z.number().int().describe('Number of the wanted memory.'),
  claim: z.number().int().describe('Number of the claim that states it.'),
}))});

const SYSTEM = 'You compare two lists of memories about one person. A wanted memory is stated by a claim when '
  + 'the claim says the same thing in other words, even if it is narrower or worded differently. A claim that '
  + 'only touches the same topic does not state it. One claim can state at most one wanted memory. '
  + 'Return only the pairs that match.';

export function makeJudge({model, apiKey, baseURL, provider = 'google'}) {
  return async (wanted, claims) => {
    if (!wanted.length || !claims.length) return [];
    const prompt = `wanted memories\n${wanted.map((g, i) => `  ${i}. ${g.statement}`).join('\n')}\n\n`
      + `claims\n${claims.map((c, i) => `  ${i}. ${c.statement}`).join('\n')}`;
    const {object} = await generateObject({
      model: providerFor({provider, apiKey, baseURL}).languageModel(model),
      schema: SCHEMA, system: SYSTEM, prompt, temperature: 0, maxRetries: 1,
      providerOptions: {google: {thinkingConfig: {thinkingLevel: 'low'}}},
    });
    return object.matches;
  };
}
