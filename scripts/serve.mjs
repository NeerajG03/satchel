#!/usr/bin/env node
// The whole thing, locally.
//
//   npm run build && npm run serve
//
// Serves the built app and every endpoint in api/ on one port, routed the way
// the deployment routes them. It needs the same environment a deploy needs;
// with none of it, the endpoints answer the way they would in production with
// a missing key, which is itself worth being able to see.
import {createLocalServer} from '../server/local-server.mjs';

const port = Number(process.env.PORT ?? 3000);
const server = await createLocalServer();
server.listen(port, '127.0.0.1', () => {
  console.log(`satchel on http://127.0.0.1:${port}`);
  console.log(`  app       /`);
  console.log(`  endpoints /api/hook-index, /api/hook-retrieve, /api/hook-capture, /api/consolidate, /api/mcp`);
  const missing = ['VITE_SUPABASE_PUBLISHABLE_KEY'].filter(name => !process.env[name]);
  if (missing.length) console.log(`\nNot set: ${missing.join(', ')}. Endpoints will answer 503.`);
  if (!process.env.SATCHEL_SUPABASE_URL)
    console.log('SATCHEL_SUPABASE_URL is not set, so this is talking to the deployed database.');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
