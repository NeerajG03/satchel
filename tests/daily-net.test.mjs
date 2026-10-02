// The review's network read: a stuck or failing call is repeated, a refusal is not.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fetchText} from '../.claude/skills/daily-improvement/scripts/net.mjs';

const fast = {timeoutMs: 150, tries: 3, waitMs: 5};

async function serve(handler) {
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); handler(hits.length, req, res); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/q?secret=do-not-print`;
  return {url, hits, close: () => { server.closeAllConnections(); server.close(); }};
}

test('a call that hangs once is tried again and answers', async () => {
  const s = await serve((n, req, res) => { if (n > 1) res.end('{"ok":1}'); });
  try {
    const out = await fetchText(s.url, {}, fast);
    assert.deepEqual([out.ok, out.status, out.text], [true, 200, '{"ok":1}']);
    assert.equal(s.hits.length, 2);
  } finally { s.close(); }
});

test('a call that always hangs fails after its tries, naming the host and not the query', async () => {
  const s = await serve(() => {});
  try {
    const started = Date.now();
    await assert.rejects(fetchText(s.url, {}, fast), error => {
      assert.match(error.message, /127\.0\.0\.1:\d+ did not answer after 3 tries/);
      assert.doesNotMatch(error.message, /secret|do-not-print/);
      return true;
    });
    assert.equal(s.hits.length, 3);
    assert.ok(Date.now() - started < 3000);
  } finally { s.close(); }
});

test('a body that stalls after the headers counts as a hang', async () => {
  const s = await serve((n, req, res) => {
    if (n === 1) { res.writeHead(200); res.write('{"par'); return; }
    res.end('{"ok":2}');
  });
  try {
    assert.equal((await fetchText(s.url, {}, fast)).text, '{"ok":2}');
  } finally { s.close(); }
});

test('a 5xx is tried again, a 4xx is returned at once', async () => {
  const flaky = await serve((n, req, res) => { res.statusCode = n === 1 ? 503 : 200; res.end('x'); });
  const refused = await serve((n, req, res) => { res.statusCode = 401; res.end('no'); });
  try {
    assert.equal((await fetchText(flaky.url, {}, fast)).status, 200);
    const out = await fetchText(refused.url, {}, fast);
    assert.deepEqual([out.ok, out.status, out.text], [false, 401, 'no']);
    assert.equal(refused.hits.length, 1);
  } finally { flaky.close(); refused.close(); }
});
