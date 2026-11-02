import {handleShelf, createDescriber} from '../server/shelf.mjs';
import {createEmbedder} from '../server/embedding.mjs';
import {flush} from '../server/tracing.mjs';

let embedder = null;
try { embedder = createEmbedder({budgetMs: 15000}); } catch { /* answered as 503 per request */ }
const describer = createDescriber();

export default async function handler(req, res) {
  try { await handleShelf(req, res, {embedder, describer}); }
  finally { await flush(); }
}
