import {handleShelf, createDescriber} from '../server/shelf.mjs';
import {createSorter} from '../server/shelf-sort.mjs';
import {createEmbedder} from '../server/embedding.mjs';
import {flush} from '../server/tracing.mjs';

let embedder = null;
try { embedder = createEmbedder({budgetMs: 15000}); } catch { /* answered as 503 per request */ }
const describer = createDescriber();
const sorter = createSorter();

export default async function handler(req, res) {
  try { await handleShelf(req, res, {embedder, describer, sorter}); }
  finally { await flush(); }
}
