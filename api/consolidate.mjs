// The background pass, as an endpoint.
//
// Nothing in a hook calls this. It reads the sessions that have gone quiet,
// runs one model call over each, and applies what it decided, so it is allowed
// to be slow and it must never be on a path anyone is waiting on.
//
// What calls it on a schedule is still open, and deliberately not decided
// here. Vercel Hobby caps crons at once a day; the candidates are Supabase
// pg_cron with pg_net, a GitHub Actions schedule, or a lazy trigger from a
// hook. All three can POST to this with the credential the hook scripts
// already hold, and RLS stays authoritative for every one of them.
import {handleConsolidate} from '../server/hook-handler.mjs';
import {createConsolidator} from '../server/consolidator.mjs';
import {createEmbedder} from '../server/embedding.mjs';
import {traced, annotate, flush} from '../server/tracing.mjs';

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

export default async function (req, res) {
  try { await handleConsolidate(req, res, {embedder, consolidator, traced}); }
  finally { await flush(); }
}
