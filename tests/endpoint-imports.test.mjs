// What each serverless entry point drags in on a cold start.
//
// /api/repository-hint needed one constant, SUPABASE_URL, and reached it
// through http-handler.mjs, which builds the MCP server, the Supabase client,
// the embedder and the router. So it loaded the entire model stack to read a
// string: 709ms of module import, measured, against 30ms once the constant
// moved to a module that imports nothing.
//
// That endpoint is the one the plugin bootstrap waits on with a 2.5 second
// timeout. A cold start over that budget is what produces "could not stage it
// for the authenticated lifecycle hook", which is not an error anyone sees as
// a cold start: it reads like a broken integration.
//
// This is a static check on purpose. Timing a require is noisy and machine
// dependent; "is this package reachable from that entry point" is neither, and
// it is the thing that actually has to stay true.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every bare package specifier reachable from an entry point, following only
 *  relative imports. Deliberately simple: these files are hand-written ESM
 *  with static imports at the top, which is the only shape it has to read. */
function packagesReachableFrom(entry) {
  const seen = new Set();
  const packages = new Set();
  const walk = file => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) walk(resolve(dirname(file), specifier));
      else packages.add(specifier.replace(/^(@[^/]+\/[^/]+|[^@/][^/]*).*$/, '$1'));
    }
    // A bare dynamic import counts too: it is deferred, not free, and on a cold
    // path it lands inside the first request rather than outside it.
    for (const match of source.matchAll(/\bimport\(\s*['"]([^'".][^'"]*)['"]\s*\)/g))
      packages.add(match[1].replace(/^(@[^/]+\/[^/]+|[^@/][^/]*).*$/, '$1'));
  };
  walk(resolve(root, entry));
  return packages;
}

// Nothing here is in these two endpoints' jobs. The model packages are the
// expensive ones, but the MCP server and jose are pure weight here as well.
const HEAVY = ['ai', '@ai-sdk/google', '@ai-sdk/openai-compatible',
  '@modelcontextprotocol/sdk', '@opentelemetry/sdk-node', '@langfuse/otel',
  '@langfuse/tracing', '@langfuse/vercel-ai-sdk', 'jose'];

test('the repository hint endpoint loads nothing it does not use', () => {
  // It reads a session key, a provider and a repository name, and calls one
  // Postgres routine. supabase-js is the only dependency that job has.
  const packages = packagesReachableFrom('api/repository-hint.mjs');
  for (const heavy of HEAVY)
    assert.ok(!packages.has(heavy),
      `api/repository-hint.mjs reaches ${heavy}. The plugin bootstrap waits 2500ms on this endpoint; `
      + 'anything it loads is spent inside that budget on every cold start.');
  assert.deepEqual([...packages].sort(), ['@supabase/supabase-js']);
});

test('the resource metadata endpoint serves a static document and loads nothing', () => {
  // It answers /.well-known/oauth-protected-resource with four fixed fields.
  assert.deepEqual([...packagesReachableFrom('api/resource-metadata.mjs')].sort(), []);
});

test('identity.mjs imports nothing, which is the whole point of it', () => {
  // The moment anything is imported here, both endpoints above inherit it and
  // the regression is invisible until someone times a cold start again.
  assert.deepEqual([...packagesReachableFrom('server/identity.mjs')].sort(), []);
  const source = readFileSync(resolve(root, 'server/identity.mjs'), 'utf8');
  assert.doesNotMatch(source, /(?:^|\n)\s*import\s/, 'identity.mjs must have no imports at all');
});

test('the MCP endpoint is allowed everything, because it uses it', () => {
  // The contrast is the point: this one genuinely builds the server, verifies a
  // token, embeds and routes, so its cold start is the price of the feature
  // rather than an accident of where a constant happened to live.
  const packages = packagesReachableFrom('api/mcp.mjs');
  for (const needed of ['ai', '@modelcontextprotocol/sdk', 'jose', '@supabase/supabase-js'])
    assert.ok(packages.has(needed), `api/mcp.mjs should reach ${needed}`);
});
