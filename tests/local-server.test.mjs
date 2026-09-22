// The endpoints, served the way the deployment serves them.
//
// Until now nothing could exercise a hook endpoint without a deploy, which is
// why both tracing bugs found on 21 September were the kind you only find in
// production. The risk with a local runner is that it routes differently from
// the real thing and you tune against a fiction, so these are almost entirely
// about the routing matching vercel.json rather than about the server.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLocalServer, loadRewrites} from '../server/local-server.mjs';

/** Starts the server on a port the OS picks, runs one call, stops it. */
async function against(options, run) {
  const server = await createLocalServer(options);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const {port} = server.address();
  try { return await run((path, init) => fetch(`http://127.0.0.1:${port}${path}`, init)); }
  finally { await new Promise(done => server.close(done)); }
}

const echo = handler => ({default: handler});

test('the rewrites are the ones in vercel.json, anchored at both ends', async () => {
  const rules = await loadRewrites();
  assert.ok(rules.length >= 3);
  // Without the anchors "/api/mcp" matches the SPA catch-all and every API
  // call answers with index.html, which reads as a broken client.
  const spa = rules.at(-1);
  assert.equal(spa.match.test('/api/mcp'), false);
  assert.equal(spa.match.test('/book'), true);
  assert.equal(rules[0].match.test('/.well-known/oauth-protected-resource'), true);
});

test('a hook endpoint gets the body already parsed, the way Vercel hands it over', async () => {
  let seen;
  await against({load: async () => echo((req, res) => {
    seen = {method: req.method, body: req.body, auth: req.headers.authorization};
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}');
  })}, async call => {
    const response = await call('/api/hook-capture', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer token'},
      body: JSON.stringify({session_key: 's1', assistant: 'Noted.'})});
    assert.equal(response.status, 200);
  });
  assert.deepEqual(seen.body, {session_key: 's1', assistant: 'Noted.'});
  assert.equal(seen.auth, 'Bearer token');
});

test('a body that is not JSON arrives as the text, and an empty one as nothing', async () => {
  // parseHookBody takes either, and the consolidation endpoint is called with
  // no body at all, which is not the same as a malformed one.
  const bodies = [];
  await against({load: async () => echo((req, res) => { bodies.push(req.body); res.writeHead(200); res.end(); })},
    async call => {
      await call('/api/consolidate', {method: 'POST', body: 'not json'});
      await call('/api/consolidate', {method: 'POST'});
    });
  assert.deepEqual(bodies, ['not json', undefined]);
});

test('a body over the limit is refused before a handler sees it', async () => {
  let reached = false;
  await against({load: async () => echo((_req, res) => { reached = true; res.writeHead(200); res.end(); })},
    async call => {
      const response = await call('/api/hook-capture', {method: 'POST', body: 'x'.repeat(300_000)});
      assert.equal(response.status, 413);
    });
  assert.equal(reached, false);
});

test('nothing outside api/ can be reached through the api path', async () => {
  await against({load: async () => { throw new Error('should not be asked'); }}, async call => {
    // The name has to be a plain one: no slashes, no dots, no extension. A
    // literal ../ is normalized away by the client before it is even sent, so
    // the ones worth asserting are the encoded and the odd.
    for (const path of ['/api/..%2Fserver%2Fidentity', '/api/Nope', '/api/no_such', '/api/mcp.mjs'])
      assert.equal((await call(path, {method: 'POST'})).status, 404, path);
  });
});

test('an endpoint that throws answers, rather than taking the process with it', async () => {
  await against({load: async () => echo(() => { throw new Error('boom'); })}, async call => {
    const response = await call('/api/hook-index', {method: 'POST', body: '{}'});
    assert.equal(response.status, 500);
    assert.match(await response.text(), /boom/, 'locally, the whole point is to see it');
  });
});

test('anything that is not an endpoint falls through to the app', async () => {
  await against({dist: new URL('.', import.meta.url).pathname, load: async () => echo(() => {})},
    async call => {
      // tests/ stands in for dist/ here: the assertion is that a path with no
      // file behind it gets the index rather than a 404, which is what makes
      // a client-side route work on a hard refresh.
      const response = await call('/some/deep/route');
      assert.equal(response.status, 404, 'and says what to do when there is no build');
      assert.match(await response.text(), /npm run build/);
    });
});
