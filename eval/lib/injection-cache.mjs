// The prompt vector cache, shared by the collector, the parity check and the
// eval, so all three key it the same way and none of them re-embeds a prompt
// another already paid for.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const promptKey = text => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The production embedding model and space: memories.embedding_model is
 *  gemini-embedding-001 with no task type, so neither is set here. The key is
 *  read from ~/.config/env and never printed. */
export async function promptEmbedder() {
  const env = readFileSync(join(process.env.HOME, '.config', 'env'), 'utf8');
  const apiKey = env.split('\n').map(l => l.replace(/^export\s+/, '').trim())
    .find(l => l.startsWith('GEMINI_API_KEY='))?.slice('GEMINI_API_KEY='.length).replace(/^['"]|['"]$/g, '');
  if (!apiKey) throw new Error('GEMINI_API_KEY is not in ~/.config/env');
  const {createEmbedder} = await import('../../server/embedding.mjs');
  return createEmbedder({apiKey, budgetMs: 60000, timeoutMs: 30000});
}

/** Embeds every text the cache lacks, in chunks, into the cache. Returns how many. */
export async function fill(cache, texts) {
  const missing = [...new Set(texts)].filter(t => !cache[promptKey(t)]);
  if (!missing.length) return 0;
  const embedder = await promptEmbedder();
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    (await embedder.embed(chunk, 'query')).forEach((v, j) => { cache[promptKey(chunk[j])] = v; });
  }
  return missing.length;
}
