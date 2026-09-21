// The end of a turn. This one is allowed to be heavy, because it runs the
// router, which is the whole point of it. Nothing is injected from here, so the
// only cost of its cold start is a reply the person sees a moment later.
import {handleHookCapture} from '../server/hook-handler.mjs';
import {createRouter} from '../server/router.mjs';
import {createEmbedder} from '../server/embedding.mjs';
import {traced, annotate, flush} from '../server/tracing.mjs';

// Built once per process, and never fatal. Without a router key capture simply
// does not happen, which is the behaviour Satchel had before it existed.
let router = null;
try { router = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY ? createRouter({annotate}) : null; }
catch { router = null; }
// A captured memory is embedded on the way in, so it can be retrieved later.
let embedder = null;
try { embedder = createEmbedder(); }
catch { /* The memory is still saved; it is embedded by the backfill instead. */ }

export default async function (req, res) {
  try { await handleHookCapture(req, res, {embedder, router, traced}); }
  finally {
    // A serverless function can freeze the moment it responds, so a batched
    // exporter would lose the spans.
    await flush();
  }
}
