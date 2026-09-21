// Every prompt. It embeds one string and runs one vector search, so it needs
// the embedder and nothing else: no router, no MCP server. The hook that calls
// it has a five second budget, because a hook that delays the prompt is worse
// than a hook that misses one.
import {handleHookRetrieve} from '../server/hook-handler.mjs';
import {createEmbedder} from '../server/embedding.mjs';
import {traced, retrieval, flush} from '../server/tracing.mjs';

// Without an embedder retrieval reports itself unavailable rather than failing
// the prompt, which is the same degradation as the service being down.
let embedder = null;
try { embedder = createEmbedder(); }
catch { /* retrieve reports itself unavailable */ }

export default async function (req, res) {
  try { await handleHookRetrieve(req, res, {embedder, traced, retrieval}); }
  finally { await flush(); }
}
