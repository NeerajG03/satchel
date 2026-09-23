// The background pass, as an endpoint.
//
// Nothing in a hook calls this. It reads the sessions that have gone quiet,
// runs one model call over each, and applies what it decided, so it is allowed
// to be slow and it must never be on a path anyone is waiting on.
//
// Two things call it: the button on the activity page, and pg_cron through
// pg_net for anyone who enabled the schedule. Either one starts a job that
// runs as a chain of these calls, each a few minutes long, for up to 30
// minutes. waitUntil is what lets a call keep working after it has answered,
// and it is a plain Vercel function feature: nothing here needs Next.js.
import {handleConsolidate} from '../server/hook-handler.mjs';
import {createConsolidator} from '../server/consolidator.mjs';
import {createEmbedder} from '../server/embedding.mjs';
import {traced, annotate, flush} from '../server/tracing.mjs';
import {waitUntil} from '@vercel/functions';

let consolidator = null;
try {
  consolidator = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY
    ? createConsolidator({annotate}) : null;
} catch { consolidator = null; }
// A memory the pass writes or extends has to be embedded on the way in, the
// same as one a person saves. This is the writer nobody checks afterwards.
let embedder = null;
try { embedder = createEmbedder(); }
catch { /* The memory is still written; the backfill embeds it instead. */ }

// The reading happens after the answer is sent, so the traces have to be
// flushed after the reading too, not when the handler returns.
const background = work => waitUntil(work.finally(flush));

export default async function (req, res) {
  try { await handleConsolidate(req, res, {embedder, consolidator, traced, background}); }
  finally { await flush(); }
}
