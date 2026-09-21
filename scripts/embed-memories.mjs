#!/usr/bin/env node
// Backfills embeddings for memories that have none, or that were embedded by a
// different model. A row without an embedding is saved and simply not
// retrievable, so this is a repair rather than a migration: it can be re-run,
// it is interruptible, and it never touches a row it does not need to.
//
//   SUPABASE_SERVICE_KEY=... node scripts/embed-memories.mjs [--dry-run]
//
// Changing embedding models means re-embedding everything, which is why the
// model name is stored next to every vector. Without that pairing a mixed
// corpus would rank against two incompatible spaces and look merely mediocre
// rather than broken.
import {createClient} from '@supabase/supabase-js';
import {createEmbedder, indexedText, toVectorLiteral} from '../server/embedding.mjs';
import {SUPABASE_URL} from '../server/http-handler.mjs';

const dryRun = process.argv.includes('--dry-run');
const key = process.env.SUPABASE_SERVICE_KEY;
if (!key) {
  console.error('SUPABASE_SERVICE_KEY is required. This writes to every owner\'s rows, so it cannot use the publishable key.');
  process.exit(2);
}
// Nothing here is behind a hook timeout, so a rate limit is worth waiting out
// rather than giving up on. The read path uses six seconds because it is; this
// is a repair that can afford a minute.
const embedder = createEmbedder({budgetMs: Number(process.env.SATCHEL_EMBEDDING_BUDGET_MS ?? 60000)});
const db = createClient(SUPABASE_URL, key, {auth: {persistSession: false, autoRefreshToken: false}});

const BATCH = 50;
let done = 0, failed = 0;

for (;;) {
  const {data: rows, error} = await db
    .from('memories')
    .select('id,statement,source,embedding_model')
    .or(`embedding_model.is.null,embedding_model.neq.${embedder.model}`)
    .limit(BATCH);
  if (error) { console.error('Could not read memories:', error.message); process.exit(1); }
  if (!rows?.length) break;

  if (dryRun) {
    console.log(`${rows.length} rows would be embedded with ${embedder.model}`);
    done += rows.length;
    if (rows.length < BATCH) break;
    // A dry run cannot make progress through the queue, so stop after one page.
    break;
  }

  let vectors;
  try { vectors = await embedder.embed(rows.map(indexedText), 'document'); }
  catch (error) {
    console.error(`\nEmbedding failed, stopping with ${done} done: ${error.message}`);
    // A spent daily quota is the one failure where re-running now is pointless,
    // and it is also the one that looks most like a transient blip.
    if (error.code === 'EMB_LIMIT')
      console.error('The rows left are still unretrievable. Re-run once the quota resets, or set '
        + 'SATCHEL_EMBEDDING_FALLBACK_KEY to a second project\'s key and re-run now.');
    process.exit(1);
  }

  const embedded_at = new Date().toISOString();
  for (const [index, row] of rows.entries()) {
    const {error} = await db.from('memories').update({
      embedding: toVectorLiteral(vectors[index]),
      embedding_model: embedder.model,
      embedded_at,
    }).eq('id', row.id);
    if (error) { failed++; console.error(`  ${row.id}: ${error.message}`); }
    else done++;
  }
  process.stdout.write(`\r  embedded ${done}${failed ? `, ${failed} failed` : ''}   `);
}
process.stdout.write('\n');
console.log(`${dryRun ? 'Would embed' : 'Embedded'} ${done} memories with ${embedder.model}.`);
if (failed) { console.error(`${failed} rows failed and are still unretrievable. Re-run to retry them.`); process.exit(1); }
