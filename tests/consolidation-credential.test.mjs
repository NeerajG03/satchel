// The credential the scheduled pass runs on.
//
// This is the only place in Satchel where a long-lived token is stored server
// side, so it is the piece most worth being paranoid about. /api/consolidate
// runs under RLS as a real person, which is what keeps one account's memory
// out of another's, and a job inside the database is nobody. The whole design
// exists to avoid the shortcut, which is a blanket key.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {exchangeRefreshToken} from '../server/agent-token.mjs';
import {applyMigrations} from './helpers/migrations.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body),
  {status, headers: {'content-type': 'application/json'}});

test('a refresh is exchanged for an ordinary access token, and the rotation comes back', async () => {
  let sent;
  const fresh = await exchangeRefreshToken({
    refreshToken: 'old-refresh', clientId: 'client-1',
    fetchImpl: async (url, init) => {
      sent = {url: String(url), body: Object.fromEntries(new URLSearchParams(init.body))};
      return json({access_token: 'access-1', refresh_token: 'new-refresh'});
    },
  });
  assert.match(sent.url, /\/oauth\/token$/);
  assert.deepEqual(sent.body,
    {grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: 'client-1'});
  assert.equal(fresh.accessToken, 'access-1');
  assert.equal(fresh.refreshToken, 'new-refresh');
});

test('a host that does not rotate leaves the caller storing something correct', async () => {
  const fresh = await exchangeRefreshToken({refreshToken: 'same', clientId: 'c',
    fetchImpl: async () => json({access_token: 'access-1'})});
  assert.equal(fresh.refreshToken, 'same');
});

test('a refused refresh carries the status, because that is what stops the job', async () => {
  // Three refusals in a row switch the credential off. A revoked grant has to
  // stop the schedule rather than be retried every six hours forever, and the
  // status code is how the database tells a revocation from an outage.
  await assert.rejects(
    exchangeRefreshToken({refreshToken: 'dead', clientId: 'c',
      fetchImpl: async () => json({error: 'invalid_grant'}, 400)}),
    error => error.status === 400 && /Refresh refused \(400\)/.test(error.message));
  await assert.rejects(
    exchangeRefreshToken({refreshToken: 'x', clientId: 'c',
      fetchImpl: async () => json({}, 200)}),
    /Refresh refused/, 'a 200 with no token is a refusal too');
  await assert.rejects(exchangeRefreshToken({clientId: 'c'}), /Missing refresh credential/);
});

test('nothing about the stored credential is reachable without being its owner', async () => {
  const db = new PGlite();
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  try {
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
    `);
    await applyMigrations(db);

    const call = async (sub, sql, params = []) => {
      await db.exec('begin; set local role authenticated;');
      try {
        await db.query("select set_config('request.jwt.claims',$1,true)",
          [JSON.stringify(sub ? {sub} : {})]);
        const result = await db.query(sql, params);
        await db.exec('commit');
        return result.rows;
      } catch (error) { await db.exec('rollback'); throw error; }
    };

    // The table holds no token, only the fact that one exists, and even that
    // is not something an agent connection has any business listing.
    await assert.rejects(call(owner, 'select * from consolidation_credentials'), {code: '42501'});
    await assert.rejects(call(owner, 'insert into consolidation_credentials(client_id,secret_id,endpoint) values($1,$2,$3)',
      ['c', crypto.randomUUID(), 'https://example.com/api/consolidate']), {code: '42501'});

    // The routine that reads the secret is the schedule's own and belongs to
    // nobody who can call it.
    const [{allowed}] = (await db.query(
      `select has_function_privilege('authenticated','private.run_consolidation()','execute') allowed`)).rows;
    assert.equal(allowed, false);

    // A session-less caller gets nothing, rather than everyone's rows.
    await assert.rejects(call(null, 'select * from consolidation_status()'), {code: '42501'});
    assert.deepEqual(await call(owner, 'select * from consolidation_status()'), [],
      'not enabled is an empty answer, not an error');

    const [{endpoint}] = (await db.query(
      `select conname, pg_get_constraintdef(oid) endpoint from pg_constraint
       where conrelid = 'public.consolidation_credentials'::regclass
         and pg_get_constraintdef(oid) like '%https%'`)).rows;
    assert.match(endpoint, /\^https\?/, 'the endpoint it posts a token to has to be a URL');
  } finally { await db.close(); }
});
