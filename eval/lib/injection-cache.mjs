// The prompt vector cache, shared by the collector, the parity check and the
// eval, so all three key it the same way and none of them re-embeds a prompt
// another already paid for.
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const promptKey = text => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The production embedding model and space: memories.embedding_model is
 *  gemini-embedding-001 with no task type, so neither is set here.
 *
 *  The key is read, never printed, from the first of these that has a
 *  GEMINI_API_KEY: `.env` in the main checkout (SATCHEL_REPO, which the review's
 *  Setup exports) and then ~/.config/env. The main checkout's is the one that
 *  works; the one in ~/.config/env has been rejected by Google.
 *
 *  A SATCHEL_EMBEDDING_KEY in the process wins over both and the embedder reads
 *  its provider, url and model from the same SATCHEL_EMBEDDING_* names the
 *  server does. That is the last resort when no Gemini key works: the same model
 *  through an OpenAI-shaped host (provider openai, url
 *  https://openrouter.ai/api/v1, model google/gemini-embedding-001), which
 *  parity proves lands in the same space. */
export async function promptEmbedder() {
  const {createEmbedder} = await import('../../server/embedding.mjs');
  if (process.env.SATCHEL_EMBEDDING_KEY) return createEmbedder({budgetMs: 60000, timeoutMs: 30000});
  const files = [process.env.SATCHEL_REPO && join(process.env.SATCHEL_REPO, '.env'),
    join(process.env.HOME, '.config', 'env')].filter(Boolean);
  const apiKey = files.map(geminiKeyIn).find(Boolean);
  if (!apiKey) throw new Error(`GEMINI_API_KEY is not in ${files.join(' or ')}`);
  return createEmbedder({apiKey, budgetMs: 60000, timeoutMs: 30000});
}

function geminiKeyIn(file) {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').split('\n').map(l => l.replace(/^export\s+/, '').trim())
    .find(l => l.startsWith('GEMINI_API_KEY='))?.slice('GEMINI_API_KEY='.length).replace(/^['"]|['"]$/g, '') || undefined;
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
