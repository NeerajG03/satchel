// The same endpoints, on one machine, without Vercel.
//
// Every handler in api/ is an ordinary (req, res) function. Vercel supplies
// three things around them and nothing else: it parses a JSON body onto
// req.body, it applies the rewrites in vercel.json, and it serves dist/ for
// anything that is not an API route. So that is all this does.
//
// Two reasons it exists. Nothing could exercise a hook endpoint without a
// deploy, which made the two tracing bugs found on 21 September the kind you
// only find in production. And a head to head against a self hosted
// supermemory has to be a command rather than a project.
//
// The rewrites are read out of vercel.json rather than restated here. A second
// copy is a second thing to forget, and the failure it produces is a local run
// that behaves differently from the deployed one, which is worse than no local
// run at all.
import {createServer as createHttpServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_BYTES = 256 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

/** The rewrites as vercel.json states them, in order. */
export async function loadRewrites(file = join(root, 'vercel.json')) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  return (config.rewrites ?? []).map(rule => ({
    // Vercel anchors a source pattern at both ends. Without that, "/api/mcp"
    // matches the SPA catch-all and every API call returns index.html, which
    // looks like a broken client rather than a broken router.
    match: new RegExp(`^${rule.source}$`),
    destination: rule.destination,
  }));
}

/** Vercel hands a handler an already-parsed body. Anything that is not JSON
 *  arrives as the raw string, which is what parseHookBody expects too. */
function readBody(req) {
  return new Promise((done, fail) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      // Drained rather than destroyed. Killing the socket here loses the 413
      // as well: the client sees a closed connection and cannot tell a body
      // that was too big from a server that fell over.
      if (size > MAX_BYTES) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) return fail(Object.assign(new Error('Too large'), {tooLarge: true}));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return done(undefined);
      try { done(JSON.parse(text)); } catch { done(text); }
    });
    req.on('error', fail);
  });
}

async function serveFile(res, file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(200, {'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size});
    await new Promise(done => createReadStream(file).on('close', done).pipe(res));
    return true;
  } catch { return false; }
}

/** An http server that routes the way the deployment does.
 *
 *  `load` is injected so a test can drive the routing without importing the
 *  model stack, and so a handler that throws at import time fails the request
 *  rather than the process. */
export async function createLocalServer({
  dist = join(root, 'dist'),
  api = join(root, 'api'),
  load = file => import(`file://${file}`),
  rewrites = null,
} = {}) {
  const rules = rewrites ?? await loadRewrites();
  const handlers = new Map();
  const handlerFor = async name => {
    if (!handlers.has(name)) {
      // Lazily, one per route, which is also how the deployment loads them:
      // an endpoint nobody calls costs nothing.
      const module = await load(join(api, `${name}.mjs`));
      handlers.set(name, module.default);
    }
    return handlers.get(name);
  };

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname;
    for (const rule of rules) {
      if (!rule.match.test(path)) continue;
      path = path.replace(rule.match, rule.destination);
      break;
    }
    if (path.startsWith('/api/')) {
      // The only thing taken from the request is a name, and it has to be a
      // plain one. No slashes, no dots, no extension: every way out of api/
      // fails this before anything is resolved against the filesystem.
      const name = path.slice(5);
      if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(404); return res.end('Not found'); }
      let handler;
      try { handler = await handlerFor(name); }
      catch { res.writeHead(404); return res.end('Not found'); }
      if (typeof handler !== 'function') { res.writeHead(404); return res.end('Not found'); }
      try { req.body = await readBody(req); }
      catch (error) { res.writeHead(error.tooLarge ? 413 : 400); return res.end(); }
      try { return await handler(req, res); }
      catch (error) {
        if (res.headersSent) return res.end();
        res.writeHead(500);
        // Locally, the whole point is to see it. Nothing here runs in front of
        // anyone but the person who started it.
        return res.end(String(error?.stack ?? error));
      }
    }
    const file = join(dist, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (path !== '/' && await serveFile(res, file)) return;
    if (await serveFile(res, join(dist, 'index.html'))) return;
    res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    res.end('No build found. Run `npm run build` first, or use `npm run dev` for the app alone.');
  });
}
