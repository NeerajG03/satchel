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
import {readFileSync, existsSync, readdirSync} from 'node:fs';
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

/** Every repository file an entry point reaches, following relative imports.
 *  Resolves the extension the way the imports are written, which is always
 *  explicit in this codebase. */
function filesReachableFrom(entry) {
  const seen = new Set();
  const walk = file => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]/g))
      walk(resolve(dirname(file), match[1]));
  };
  walk(resolve(root, entry));
  return seen;
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

test('the session-start endpoint stays light, because a session waits on it', () => {
  // This one runs inside a 10 second hook timeout at the moment a session
  // opens, on every startup, clear, compact and resume. It reads an index and
  // resolves a repository; it does not route, does not embed, and must not load
  // anything that does.
  //
  // tracing.mjs is the one to watch. It imports `ai`, the OpenTelemetry node
  // SDK and three Langfuse packages, and it used to be a plain import inside
  // the lifecycle code. It is passed in now, which is the only reason this
  // assertion can hold.
  const packages = packagesReachableFrom('api/hook-index.mjs');
  // jose is the exception, and it is the whole job: this endpoint exists to
  // answer an authenticated caller, so verifying the token is not overhead.
  for (const heavy of HEAVY.filter(name => name !== 'jose'))
    assert.ok(!packages.has(heavy),
      `api/hook-index.mjs reaches ${heavy}. A session start waits on this endpoint; `
      + 'anything it loads is spent inside that budget on every cold start.');
  assert.deepEqual([...packages].sort(), ['@supabase/supabase-js', 'jose']);
});

test('the retrieve endpoint loads the embedder and not the router', () => {
  // It runs on every prompt inside a five second budget. It embeds one string
  // and runs one vector search, so `ai` is the price of the feature; the
  // router and the MCP server are not.
  const packages = packagesReachableFrom('api/hook-retrieve.mjs');
  for (const heavy of ['@modelcontextprotocol/sdk'])
    assert.ok(!packages.has(heavy), `api/hook-retrieve.mjs reaches ${heavy}, which it never uses`);
  for (const needed of ['ai', '@supabase/supabase-js', 'jose'])
    assert.ok(packages.has(needed), `api/hook-retrieve.mjs should reach ${needed}`);
});

test('the capture endpoint is allowed the model stack, because it runs the router', () => {
  // The contrast is the point. Nothing is injected from capture, so its cold
  // start costs a line the person reads a moment later rather than a session
  // that opens without memory.
  const packages = packagesReachableFrom('api/hook-capture.mjs');
  for (const needed of ['ai', '@supabase/supabase-js', 'jose'])
    assert.ok(packages.has(needed), `api/hook-capture.mjs should reach ${needed}`);
});

test('the consolidation endpoint is allowed the model stack and not the MCP server', () => {
  // Nothing waits on this one at all: it runs after a conversation has gone
  // quiet, so a cold start costs nobody anything. It still has no business
  // building an MCP server.
  const packages = packagesReachableFrom('api/consolidate.mjs');
  assert.ok(!packages.has('@modelcontextprotocol/sdk'),
    'api/consolidate.mjs reaches the MCP server, which it never uses');
  for (const needed of ['ai', '@supabase/supabase-js', 'jose'])
    assert.ok(packages.has(needed), `api/consolidate.mjs should reach ${needed}`);
});

test('the MCP endpoint is allowed everything, because it uses it', () => {
  // The contrast is the point: this one genuinely builds the server, verifies a
  // token, embeds and routes, so its cold start is the price of the feature
  // rather than an accident of where a constant happened to live.
  const packages = packagesReachableFrom('api/mcp.mjs');
  for (const needed of ['ai', '@modelcontextprotocol/sdk', 'jose', '@supabase/supabase-js'])
    assert.ok(packages.has(needed), `api/mcp.mjs should reach ${needed}`);
});

test('every endpoint that reads a prompt from disk has it bundled', () => {
  // server/prompts/*.md is read with readFileSync at import, so a function
  // that is not listed under includeFiles does not fail at deploy. It fails on
  // the first request, which is the kind of failure that hides.
  const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
  const bundled = new Set(Object.entries(vercel.functions ?? {})
    .filter(([, config]) => String(config.includeFiles ?? '').includes('server/prompts'))
    .map(([file]) => file));
  const needs = readdirSync(resolve(root, 'api'))
    .map(name => `api/${name}`)
    .filter(entry => filesReachableFrom(entry).has(resolve(root, 'server/prompt-store.mjs')));
  assert.ok(needs.length, 'this test is meaningless if it found no prompt readers');
  for (const entry of needs)
    assert.ok(bundled.has(entry),
      `${entry} reaches prompt-store.mjs, so vercel.json must include server/prompts/** for it`);
});
