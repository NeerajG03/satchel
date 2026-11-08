import {test} from 'node:test';
import assert from 'node:assert/strict';
import {domainOf, isPrivateAddress, readPreview, fetchPreview} from '../server/link-preview.mjs';
import {handleShelf} from '../server/shelf.mjs';

process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= 'test-publishable';

test('a link is shown by its site alone', () => {
  assert.equal(domainOf('https://www.instagram.com/reel/DfcWKTMB8as/?srtk=MXhmaz'), 'instagram.com');
  assert.equal(domainOf('http://news.ycombinator.com/item?id=1'), 'news.ycombinator.com');
  assert.equal(domainOf('not a link'), null);
});

test('the server never opens its own machine, its network or a metadata address', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1']) assert.equal(isPrivateAddress(a), true, a);
  // A bracketed address in a link reaches the check in the form URL parsing writes it.
  assert.equal(isPrivateAddress(new URL('http://[::ffff:127.0.0.1]/').hostname.replace(/^\[|\]$/g, '')), true);
  assert.equal(isPrivateAddress('::ffff:8e fa:502e'.replace(' ', '')), false);
  for (const a of ['142.250.80.46', '31.13.71.174', '2a03:2880:f12f:83:face:b00c::25de']) assert.equal(isPrivateAddress(a), false, a);
});

test('a page is read for its preview: Open Graph first, then the title', () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="Face shape analysis &#8211; a guide">
    <meta content='Find your face shape in a minute.' property='og:description'>
    <meta property="og:image" content="/cover.jpg"><meta property="og:site_name" content="Instagram"></head></html>`;
  assert.deepEqual(readPreview(html, 'https://www.instagram.com/reel/x/'), {
    url: 'https://www.instagram.com/reel/x/', domain: 'instagram.com', title: 'Face shape analysis – a guide',
    description: 'Find your face shape in a minute.', image: 'https://www.instagram.com/cover.jpg', site: 'Instagram',
  });
  assert.equal(readPreview('<title>Only a title</title>', 'https://a.example/').title, 'Only a title');
  // A picture that would load over plain http is not shown.
  assert.equal(readPreview('<meta property="og:image" content="http://a.example/i.jpg">', 'http://a.example/').image, null);
});

const page = (html, init = {}) => new Response(html, {status: 200, headers: {'content-type': 'text/html'}, ...init});

test('a redirect onto a private address is refused, hop by hop', async () => {
  const seen = [];
  const check = async url => { seen.push(url.hostname); return url.hostname !== '169.254.169.254'; };
  const fetchImpl = async () => new Response(null, {status: 302, headers: {location: 'http://169.254.169.254/latest/meta-data'}});
  assert.equal(await fetchPreview('https://short.example/x', {fetchImpl, check}), null);
  assert.deepEqual(seen, ['short.example', '169.254.169.254']);
});

test('only web pages are read, and a page with nothing to show gives no preview', async () => {
  const check = async () => true;
  assert.equal(await fetchPreview('file:///etc/passwd', {check: undefined}), null);
  assert.equal(await fetchPreview('http://localhost:3000/', {check: undefined}), null);
  assert.equal(await fetchPreview('https://a.example/', {check, fetchImpl: async () => page('{}', {headers: {'content-type': 'application/json'}})}), null);
  assert.equal(await fetchPreview('https://a.example/', {check, fetchImpl: async () => page('<p>hi</p>')}), null);
  const found = await fetchPreview('https://a.example/x', {check, fetchImpl: async () => page('<meta property="og:title" content="Hi">')});
  assert.equal(found.title, 'Hi');
  assert.equal(found.url, 'https://a.example/x');
});

test('the Shelf reads a preview only for a signed-in person', async () => {
  const res = () => { const r = {status: 0, headers: {}, body: ''}; r.setHeader = () => {}; r.writeHead = s => { r.status = s; }; r.end = b => { r.body = b ?? ''; }; return r; };
  const verify = async token => { if (token !== 'person') throw Error('bad'); return {sub: 'alice'}; };
  const deps = {embedder: null, verify, makeClient: () => ({}), preview: async url => ({url, domain: domainOf(url), title: 'T'})};
  const out = res();
  await handleShelf({method: 'POST', headers: {authorization: 'Bearer person'}, body: {action: 'preview', url: 'https://www.a.example/p'}}, out, deps);
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.body).preview.domain, 'a.example');
  const refused = res();
  await handleShelf({method: 'POST', headers: {}, body: {action: 'preview', url: 'https://a.example/'}}, refused, deps);
  assert.equal(refused.status, 401);
});
