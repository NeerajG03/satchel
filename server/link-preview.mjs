import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const TIMEOUT_MS = 4000;
const MAX_BYTES = 256 * 1024;
const MAX_HOPS = 3;
// Many sites hand their preview tags only to link-preview crawlers.
const AGENT = 'facebookexternalhit/1.1 (+https://satchel-pi.vercel.app)';

/** The site's name as a person reads it: no scheme, no www, no path. */
export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

/**
 * An address the server must never fetch for a person: anything on its own
 * machine or network, or a cloud metadata address. A preview is only ever of a
 * public web page.
 */
export function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = address.toLowerCase();
  // An IPv4 address inside IPv6, dotted (::ffff:127.0.0.1) or as URL parsing writes it (::ffff:7f00:1).
  const mapped = v6.match(/^(?:0*:)*:?(?:0*:)?ffff:(?:0+:)?(.+)$/)?.[1] ?? v6.match(/^64:ff9b::(.+)$/)?.[1];
  if (mapped) {
    if (isIP(mapped) === 4) return isPrivateAddress(mapped);
    const hex = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

async function checkHost(url) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  if (url.port && !['80', '443'].includes(url.port)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isPrivateAddress(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || !host.includes('.')) return false;
  const addresses = await lookup(host, {all: true}).catch(() => []);
  return addresses.length > 0 && addresses.every(a => !isPrivateAddress(a.address));
}

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code) => {
  if (code[0] === '#') {
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
  }
  return ENTITIES[code.toLowerCase()] ?? whole;
}).replace(/\s+/g, ' ').trim();

/** The preview tags of a page: Open Graph first, then Twitter's, then the page title. */
export function readPreview(html, pageUrl) {
  const head = html.slice(0, MAX_BYTES);
  const tags = {};
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = name => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    const key = attr('property') ?? attr('name');
    const content = attr('content');
    if (!key || !content) continue;
    const name = (key[2] ?? key[3]).toLowerCase();
    if (!(name in tags)) tags[name] = decode(content[2] ?? content[3]);
  }
  const titleTag = head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const pick = (...names) => names.map(n => tags[n]).find(Boolean) ?? null;
  let image = pick('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
  try { image = image ? new URL(image, pageUrl).href : null; } catch { image = null; }
  if (image && !image.startsWith('https://')) image = null;
  const clip = (text, n) => text && text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;
  return {
    url: pageUrl,
    domain: domainOf(pageUrl),
    title: clip(pick('og:title', 'twitter:title') ?? (titleTag ? decode(titleTag) : null), 200),
    description: clip(pick('og:description', 'twitter:description', 'description'), 300),
    image,
    site: clip(pick('og:site_name'), 80),
  };
}

async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

/**
 * Opens a public web page and reads its preview. Each redirect is checked like
 * the first address, so a public link cannot bounce the server onto a private one.
 * Null when there is nothing to show; the link is still shown by its domain.
 */
export async function fetchPreview(link, {fetchImpl = fetch, check = checkHost} = {}) {
  let url;
  try { url = new URL(link); } catch { return null; }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!(await check(url))) return null;
    let response;
    try {
      response = await fetchImpl(url.href, {redirect: 'manual', signal,
        headers: {'user-agent': AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en'}});
    } catch { return null; }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      try { url = new URL(response.headers.get('location'), url); } catch { return null; }
      continue;
    }
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('html')) return null;
    const preview = readPreview(await readCapped(response).catch(() => ''), url.href);
    return preview.title || preview.image ? {...preview, url: link} : null;
  }
  return null;
}
