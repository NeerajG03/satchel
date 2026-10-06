// The schedule a person sets in Settings for the background pass.
//
// Two things are at stake and both are tested through real SQL. One is who may
// touch it: only the person's own browser session, never an app they
// connected, because a schedule decides when model spend happens on their
// behalf. The other is when it fires: once per slot, not at all for a slot
// that is long gone, and never for a night with nothing to read.
import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

const owner = crypto.randomUUID(), other = crypto.randomUUID();
const person = {sub: owner};
const app = {sub: owner, client_id: 'some-app', satchel_grant_id: 'g1'};
const ENDPOINT = 'https://satchel.example/api/consolidate';

// One database for the file. Replaying every migration takes about a second,
// and every test starts by emptying what the last one left.
let db, call, enable, set;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth; create schema storage;
    create table storage.objects(bucket_id text,name text,metadata jsonb,user_metadata jsonb);
    create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as
      $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    insert into auth.users values('${owner}'),('${other}');
    -- The Vault and pg_net are Supabase's. These stand in for the two things
    -- the routines use: a place a secret goes, and a log of what was posted.
    create schema vault;
    create table vault.secrets(id uuid primary key default gen_random_uuid(), secret text, name text, description text);
    create function vault.create_secret(s text, n text default null, d text default null) returns uuid
      language sql as $$ insert into vault.secrets(secret,name,description) values(s,n,d) returning id $$;
    create function vault.update_secret(i uuid, s text default null, n text default null, d text default null)
      returns void language sql as $$ update vault.secrets set secret = coalesce(s, secret) where id = i $$;
    create view vault.decrypted_secrets as select id, secret as decrypted_secret from vault.secrets;
    create schema net;
    create table net._http_response(id bigint primary key, status_code int, error_msg text, content text);
    create table net.sent(id bigserial primary key, url text, headers jsonb);
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 1000)
      returns bigint language sql as $$ insert into net.sent(url, headers) values (url, headers) returning id $$;
  `);
  await applyMigrations(db);
  call = async (claims, sql, params = []) => {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims ?? {})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  };
  enable = (claims, days = null, times = null, zone = null, endpoint = ENDPOINT) => call(claims,
    'select public.enable_consolidation($1,$2,$3,30,$4::smallint[],$5::time[],$6)',
    ['client-1', 'refresh-1', endpoint, days, times, zone]);
  set = (claims, days, times, zone) => call(claims,
    'select public.set_consolidation_schedule($1::smallint[],$2::time[],$3)', [days, times, zone]);
});
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec(`truncate public.consolidation_credentials, public.document_turns, public.documents cascade;
    truncate vault.secrets, net.sent, net._http_response;`);
});

test('a person switches it on with a schedule, and reads it back', async () => {
  await enable(person, '{1,2,3,4,5}', '{02:00,14:30}', 'Asia/Kolkata');
  const [row] = await call(person, 'select * from consolidation_status()');
  assert.equal(row.enabled, true);
  assert.deepEqual(row.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(row.times, ['02:00:00', '14:30:00']);
  assert.equal(row.timezone, 'Asia/Kolkata');
  assert.equal(row.client_id, 'client-1');
});

test('with no schedule given it is every night at two, which is what overnight means', async () => {
  await enable(person);
  const [row] = await call(person, 'select * from consolidation_status()');
  assert.deepEqual(row.days, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(row.times, ['02:00:00']);
  assert.equal(row.timezone, 'UTC');
});

test('an empty list is a choice, not a missing argument, so switching on refuses it like setting does', async () => {
  const refused = (days, times, pattern) => assert.rejects(enable(person, days, times, 'UTC'),
    error => error.code === '22023' && pattern.test(error.message));
  await refused('{}', '{02:00}', /at least one day/);
  await refused('{1}', '{}', /one time, or two at most/);
  assert.deepEqual(await call(person, 'select * from consolidation_status()'), [], 'and nothing was stored');
});

test('the address the token is posted to must be this deployment, over https', async () => {
  const refused = endpoint => assert.rejects(enable(person, null, null, null, endpoint),
    error => error.code === '22023' && /over https/.test(error.message));
  await refused('http://satchel.example/api/consolidate');
  await refused('https://satchel.example/api/other');
  await refused('https://satchel.example/api/consolidate?x=1');
  await refused('https://user@satchel.example/api/consolidate');
  await refused('https://satchel.example/x/api/consolidate');
  await refused('http://127.0.0.1:5173/api/consolidate');
  await enable(person, null, null, null, 'https://satchel-pi.vercel.app/api/consolidate');
});

test('days and times are put in order, deduplicated and cut to the minute', async () => {
  await enable(person);
  await set(person, '{3,1,1,3}', '{14:00:45,02:00:10,02:00:50}', 'Europe/London');
  const [row] = await call(person, 'select * from consolidation_status()');
  assert.deepEqual(row.days, [1, 3]);
  assert.deepEqual(row.times, ['02:00:00', '14:00:00']);
});

test('a connected app cannot turn it on, off, retime it, or even read it', async () => {
  await enable(person);
  await assert.rejects(enable(app), {code: '42501'});
  await assert.rejects(set(app, '{1}', '{03:00}', 'UTC'), {code: '42501'});
  await assert.rejects(call(app, 'select public.disable_consolidation()'), {code: '42501'});
  await assert.rejects(call(app, 'select * from consolidation_status()'), {code: '42501'});
  // Nothing the app tried moved it.
  const [row] = await call(person, 'select * from consolidation_status()');
  assert.equal(row.enabled, true);
  assert.deepEqual(row.times, ['02:00:00']);
});

test('the job\'s own client can still hand back the rotated token', async () => {
  // The endpoint calls this as the job's client after every run. Closing the
  // four routines above must not have closed this one.
  await enable(person);
  await call({sub: owner, client_id: 'client-1', satchel_grant_id: 'g1'},
    'select public.rotate_consolidation_credential($1)', ['refresh-2']);
  const [{secret}] = (await db.query('select secret from vault.secrets')).rows;
  assert.equal(secret, 'refresh-2');
});

test('signed out gets nothing, and nobody sets someone else\'s schedule', async () => {
  await enable(person, '{1}', '{05:00}', 'UTC');
  await assert.rejects(set(null, '{1}', '{05:00}', 'UTC'), {code: '42501'});
  await assert.rejects(call(null, 'select * from consolidation_status()'), {code: '42501'});
  // Another person has no row, so their attempt finds nothing to change and
  // says so. It does not fall through to mine.
  await assert.rejects(set({sub: other}, '{0,6}', '{09:00}', 'UTC'), {code: 'P0002'});
  assert.deepEqual(await call({sub: other}, 'select * from consolidation_status()'), []);
  const [row] = await call(person, 'select * from consolidation_status()');
  assert.deepEqual(row.days, [1]);
  assert.deepEqual(row.times, ['05:00:00']);
});

test('a schedule that is not a schedule is refused with a sentence', async () => {
  await enable(person);
  const refused = (days, times, zone, pattern) => assert.rejects(
    set(person, days, times, zone), error => error.code === '22023' && pattern.test(error.message));
  await refused('{}', '{02:00}', 'UTC', /at least one day/);
  await refused('{7}', '{02:00}', 'UTC', /at least one day/);
  await refused('{-1}', '{02:00}', 'UTC', /at least one day/);
  await refused('{1}', '{}', 'UTC', /one time, or two at most/);
  await refused('{1}', '{01:00,02:00,03:00}', 'UTC', /one time, or two at most/);
  await refused('{1}', '{02:00,02:30}', 'UTC', /an hour apart/);
  await refused('{1}', '{23:30,00:15}', 'UTC', /an hour apart/);
  await refused('{1}', '{02:00}', 'Mars/Phobos', /time zone/);
  await refused('{1}', '{02:00}', 'drop table x', /time zone/);
  await refused('{1}', '{02:00}', '', /time zone/);
  // Exactly an hour apart is allowed, and so is a pair that wraps midnight.
  await set(person, '{1}', '{02:00,03:00}', 'UTC');
  await set(person, '{1}', '{23:00,00:00}', 'UTC');
});

test('setting a schedule before switching it on says to switch it on', async () => {
  await assert.rejects(set(person, '{1}', '{02:00}', 'UTC'),
    error => error.code === 'P0002' && /Switch the overnight pass on first/.test(error.message));
});

test('off destroys the token, not just the flag', async () => {
  await enable(person);
  assert.equal((await db.query('select count(*)::int n from vault.secrets')).rows[0].n, 1);
  await call(person, 'select public.disable_consolidation()');
  assert.equal((await db.query('select count(*)::int n from vault.secrets')).rows[0].n, 0);
  assert.deepEqual(await call(person, 'select * from consolidation_status()'), []);
});

test('off also cleans up a pass that switched itself off', async () => {
  await enable(person);
  await db.exec('update public.consolidation_credentials set enabled = false, failures = 3');
  await call(person, 'select public.disable_consolidation()');
  assert.equal((await db.query('select count(*)::int n from vault.secrets')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from public.consolidation_credentials')).rows[0].n, 0);
});

test('consolidation_due: a slot fires once, on its day, and not when it is stale', async () => {
  const due = async (days, times, zone, last, at) => (await db.query(
    'select private.consolidation_due($1::smallint[],$2::time[],$3,$4::timestamptz,$5::timestamptz) as due',
    [days, times, zone, last, at])).rows[0].due;
  const all = '{0,1,2,3,4,5,6}';
  // 2026-10-07 is a Wednesday.
  assert.equal(await due(all, '{02:00}', 'UTC', null, '2026-10-07T02:05:00Z'), true, 'just after the slot');
  assert.equal(await due(all, '{02:00}', 'UTC', null, '2026-10-07T01:55:00Z'), false, 'not yet');
  assert.equal(await due(all, '{02:00}', 'UTC', '2026-10-07T02:01:00Z', '2026-10-07T02:16:00Z'), false,
    'already ran for this slot, so the next tick does nothing');
  assert.equal(await due(all, '{02:00}', 'UTC', '2026-10-06T02:01:00Z', '2026-10-07T02:16:00Z'), true,
    'yesterday\'s run does not use up today\'s slot');
  assert.equal(await due(all, '{02:00}', 'UTC', null, '2026-10-07T05:30:00Z'), false,
    'a slot three and a half hours old is stale: a night of downtime does not run at breakfast');
  assert.equal(await due(all, '{02:00}', 'UTC', null, '2026-10-07T04:59:00Z'), true, 'but it holds for three hours');

  // Weekdays only. The slot at 02:05 on Saturday is not one.
  assert.equal(await due('{1,2,3,4,5}', '{02:00}', 'UTC', null, '2026-10-10T02:05:00Z'), false, 'Saturday');
  assert.equal(await due('{1,2,3,4,5}', '{02:00}', 'UTC', null, '2026-10-09T02:05:00Z'), true, 'Friday');

  // The day is the person's day, not UTC's. 02:00 in Kolkata is 20:30 UTC the evening before.
  assert.equal(await due('{3}', '{02:00}', 'Asia/Kolkata', null, '2026-10-06T20:45:00Z'), true,
    'Wednesday in Kolkata, still Tuesday in UTC');
  assert.equal(await due('{2}', '{02:00}', 'Asia/Kolkata', null, '2026-10-06T20:45:00Z'), false);

  // A slot just before midnight still counts just after it, on the day it belongs to.
  assert.equal(await due('{2}', '{23:50}', 'UTC', null, '2026-10-07T00:10:00Z'), true, 'Tuesday 23:50, seen on Wednesday');
  assert.equal(await due('{3}', '{23:50}', 'UTC', null, '2026-10-07T00:10:00Z'), false);

  // Twice a day: each is its own slot.
  assert.equal(await due(all, '{02:00,14:00}', 'UTC', '2026-10-07T02:01:00Z', '2026-10-07T14:05:00Z'), true,
    'the morning run does not stand in for the afternoon one');
});

const slotFiveMinutesAgo = `update public.consolidation_credentials
  set times = array[((now() at time zone 'UTC') - interval '5 minutes')::time], last_run_at = null`;
const tick = async () => (await db.query('select private.run_consolidation() n')).rows[0].n;
const posted = async () => (await db.query('select count(*)::int n from net.sent')).rows[0].n;
const waiting = async () => {
  const [{id}] = (await db.query(
    `insert into public.documents(owner_id, session_key, last_turn_at)
     values ($1, 's' || gen_random_uuid()::text, now() - interval '1 hour') returning id`, [owner])).rows;
  await db.query(`insert into public.document_turns(document_id, owner_id, role, content)
    values ($1, $2, 'user', 'hello')`, [id, owner]);
};

test('the tick posts for a due slot once, and never for a night with nothing to read', async () => {
  await enable(person, '{0,1,2,3,4,5,6}', '{02:00}', 'UTC');
  await db.exec(slotFiveMinutesAgo);

  // Nothing to read: a slot is due and it still does not call anything.
  assert.equal(await tick(), 0);
  assert.equal(await posted(), 0);

  await waiting();
  assert.equal(await tick(), 1);
  const [sent] = (await db.query('select url, headers from net.sent')).rows;
  assert.equal(sent.url, ENDPOINT);
  assert.equal(sent.headers['x-satchel-client'], 'client-1');

  // The next tick, fifteen minutes on, is the same slot. It must not post again.
  assert.equal(await tick(), 0);
  assert.equal(await posted(), 1);

  // A slot that was four hours ago is stale, so a later conversation waits for the next one.
  await db.exec(`update public.consolidation_credentials
    set times = array[((now() at time zone 'UTC') - interval '4 hours')::time], last_run_at = null`);
  assert.equal(await tick(), 0);

  // Switched off means the tick does not even look.
  await db.exec(slotFiveMinutesAgo);
  await db.exec('update public.consolidation_credentials set enabled = false');
  assert.equal(await tick(), 0);
});

test('one refused request is one refusal, however many ticks go by', async () => {
  // pg_net keeps a response for hours and the tick runs every 15 minutes. Read
  // each time, a single 503 at the 02:00 slot would be three refusals by 02:45
  // and the pass would switch itself off over one cold start.
  await enable(person, '{0,1,2,3,4,5,6}', '{02:00}', 'UTC');
  await db.exec(slotFiveMinutesAgo);
  await waiting();
  assert.equal(await tick(), 1);
  const [{last_request_id: request}] = (await db.query('select last_request_id from public.consolidation_credentials')).rows;
  await db.query(`insert into net._http_response(id, status_code, content) values ($1, 503, 'cold start')`, [request]);

  for (let i = 0; i < 6; i++) await tick();
  const [row] = (await db.query('select enabled, failures, last_status, last_error, last_request_id from public.consolidation_credentials')).rows;
  assert.equal(row.failures, 1, 'six more ticks read the same answer and count it once');
  assert.equal(row.enabled, true);
  assert.equal(row.last_status, 503);
  assert.equal(row.last_error, 'cold start');
  assert.equal(row.last_request_id, null, 'an answer that has been read is not read again');

  // Three separate requests refused is what switches it off.
  for (const failures of [2, 3]) {
    await db.exec(slotFiveMinutesAgo);
    await tick();
    const [{last_request_id: next}] = (await db.query('select last_request_id from public.consolidation_credentials')).rows;
    await db.query(`insert into net._http_response(id, status_code, content) values ($1, 503, 'refused')`, [next]);
    await tick();
    const [{failures: counted}] = (await db.query('select failures from public.consolidation_credentials')).rows;
    assert.equal(counted, failures);
  }
  assert.equal((await db.query('select enabled from public.consolidation_credentials')).rows[0].enabled, false);
});

test('an answer that worked clears the count, and signing in again forgets an old refusal', async () => {
  await enable(person, '{0,1,2,3,4,5,6}', '{02:00}', 'UTC');
  await db.exec(slotFiveMinutesAgo);
  await waiting();
  await tick();
  const [{last_request_id: request}] = (await db.query('select last_request_id from public.consolidation_credentials')).rows;
  await db.exec('update public.consolidation_credentials set failures = 2');
  await db.query(`insert into net._http_response(id, status_code) values ($1, 200)`, [request]);
  await tick();
  assert.equal((await db.query('select failures from public.consolidation_credentials')).rows[0].failures, 0);

  // A refusal that arrived before the person signed in again is not about the new token.
  await db.exec(slotFiveMinutesAgo);
  await tick();
  const [{last_request_id: stale}] = (await db.query('select last_request_id from public.consolidation_credentials')).rows;
  await db.query(`insert into net._http_response(id, status_code, content) values ($1, 401, 'revoked')`, [stale]);
  await enable(person);
  await tick();
  const [row] = (await db.query('select enabled, failures from public.consolidation_credentials')).rows;
  assert.equal(row.failures, 0);
  assert.equal(row.enabled, true);
});
