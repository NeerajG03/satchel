#!/usr/bin/env node
// Turns the six hourly consolidation pass on, once, for you.
//
//   npm run consolidation:enable               # show what is set up
//   npm run consolidation:enable -- --enable   # sign in and turn it on
//   npm run consolidation:enable -- --disable  # turn it off and destroy the token
//
// **This is a developer path and it is not how consolidation normally runs.**
// By default the Stop hook spawns integrations/shared/consolidate.mjs detached
// and the pass uses the credential the plugin already holds, so a person
// installing Satchel does nothing at all. See docs/memory-hooks.md.
//
// What this adds is the one thing the hook cannot do: process conversations
// while you are away and never open a session. It costs a second sign-in and a
// second long-lived token, so it is deliberately not surfaced in the product.
//
// Why a sign-in rather than a setting. The pass runs with nobody at the
// keyboard, and /api/consolidate runs under RLS as a real person, which is the
// property that keeps one account's memory out of another's. A job inside the
// database is nobody, so it has to be given a connection of its own, and the
// only thing that can give it one is you, in a browser, once.
//
// What it does:
//
//   registers a second OAuth client, "Satchel consolidation", separate from
//   the plugin's, so revoking either in Apps leaves the other alone
//
//   runs the ordinary consent flow and gets a refresh token
//
//   puts that token in your own Supabase Vault, encrypted, reachable only by
//   a security definer routine. It is rotated on every run
//
// It never writes the token to disk and never prints it.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createClient} from '@supabase/supabase-js';
import {connect, satchelHome, ISSUER, SATCHEL_URL} from '../integrations/shared/auth.mjs';
import {SUPABASE_URL} from '../server/identity.mjs';

const args = process.argv.slice(2);
const flag = name => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? null : (args[at + 1]?.startsWith('--') ? true : args[at + 1] ?? true);
};

// npm run consolidation:enable loads .env for this, the same file Vite reads.
// The publishable key is not a secret; it ships inside the built app.
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!key) {
  console.error('Set VITE_SUPABASE_PUBLISHABLE_KEY. It is in .env and it is not a secret.');
  console.error('Run this through npm, which loads .env, rather than node directly.');
  process.exit(1);
}

/** The consolidation client id, and only the id.
 *
 *  Registering is once per machine, not once per run. Without remembering it,
 *  every --enable would leave another dead client and another row in Apps for
 *  you to clean up, and --disable would register a client purely in order to
 *  authenticate the request that turns the job off. A client id is not a
 *  secret; the token it is for never touches this disk. */
const clientPath = () => join(satchelHome(), 'consolidation-client.json');
const rememberedClient = () => {
  try { return JSON.parse(readFileSync(clientPath(), 'utf8'))?.client_id ?? null; }
  catch { return null; }
};
const rememberClient = client_id => {
  try {
    mkdirSync(satchelHome(), {recursive: true, mode: 0o700});
    writeFileSync(clientPath(), JSON.stringify({client_id}, null, 2) + '\n', {mode: 0o600});
  } catch { /* It still works, it just registers again next time. */ }
};
const endpoint = String(flag('endpoint') ?? `${SATCHEL_URL}/api/consolidate`);
const idle = Number(flag('idle') ?? 30);

/** A client speaking as the person who just signed in. */
const as = accessToken => createClient(SUPABASE_URL, key, {
  auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
  global: {headers: {Authorization: `Bearer ${accessToken}`}},
});

async function signIn() {
  console.log(`Signing in to ${ISSUER} as a separate client, "Satchel consolidation".`);
  console.log('This is not the plugin\'s connection. Revoking one leaves the other alone.\n');
  const credentials = await connect({clientName: 'Satchel consolidation', persist: false,
    clientId: rememberedClient(), log: message => console.log(message)});
  rememberClient(credentials.client_id);
  return credentials;
}

async function report(db) {
  const {data, error} = await db.rpc('consolidation_status');
  if (error) throw error;
  const row = data?.[0];
  if (!row) return console.log('Consolidation is not enabled for this account.');
  console.log(`enabled     ${row.enabled}`);
  console.log(`endpoint    ${row.endpoint}`);
  console.log(`idle        ${row.idle_minutes} minutes before a session counts as finished`);
  console.log(`last run    ${row.last_run_at ?? 'never'}${row.last_status ? ` (${row.last_status})` : ''}`);
  if (row.last_error) console.log(`last error  ${row.last_error}`);
  if (row.failures) console.log(`failures    ${row.failures} in a row; three switches it off`);
  // The schedule is installed by a guarded block in the migration, because a
  // project without pg_cron must still deploy. So whether it actually
  // installed is a real question and worth answering out loud.
  console.log(`scheduled   ${row.scheduled ? 'yes, every six hours' : 'NO. pg_cron is not installed, so nothing will run'}`);
}

if (flag('disable')) {
  const credentials = await signIn();
  const db = as(credentials.access_token);
  const {error} = await db.rpc('disable_consolidation');
  if (error) { console.error(error.message); process.exit(1); }
  console.log('\nTurned off, and the stored token is destroyed.');
  console.log('Revoke "Satchel consolidation" in Apps as well if you want the grant gone too.');
  process.exit(0);
}

if (!flag('enable')) {
  console.log(`Reading the status needs a sign-in too, because nothing about this is readable without one.\n`);
  const credentials = await signIn();
  await report(as(credentials.access_token));
  console.log('\nAdd --enable to turn it on, --disable to turn it off.');
  process.exit(0);
}

const credentials = await signIn();
const db = as(credentials.access_token);
const {error} = await db.rpc('enable_consolidation', {
  p_client_id: credentials.client_id,
  p_refresh_token: credentials.refresh_token,
  p_endpoint: endpoint,
  p_idle_minutes: Number.isInteger(idle) ? idle : 30,
});
if (error) {
  console.error(`\nCould not store the credential: ${error.message}`);
  console.error('If this says the vault schema does not exist, enable the Vault on the project first.');
  process.exit(1);
}
console.log('\nStored. The token is in your own Vault, encrypted, and rotated on every run.\n');
await report(db);
console.log('\nThe Stop hook already runs this pass with its own credential, so this only adds');
console.log('processing while you are away. Set memory_settings.capture_mode to \'session\' when');
console.log('you want the pass to be the writer instead of the turn-by-turn router.');
