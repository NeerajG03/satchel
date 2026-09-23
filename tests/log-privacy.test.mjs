// The logs that hold what people said are the person's, not their apps'.
//
// consolidation_runs, router_runs and memory_injections each keep
// conversation text. An agent token is `authenticated` with `sub` = the
// owner, so an owner-only policy let any connected app read them with its own
// token, whatever projects it was granted. These run the migrations in PGlite
// and prove the browser still reads everything, the server can still write as
// whoever called it, and an app reads back only the capture runs it wrote.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

async function database() {
  const db = new PGlite();
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
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
  async function call(sub, sql, params = [], extra = {}) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub, ...extra})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  return {db, owner, other, call};
}

const hook = {client_id: 'satchel-hooks', satchel_grant_id: crypto.randomUUID()};
const app = {client_id: 'claude-ai', satchel_grant_id: crypto.randomUUID()};

const writeAll = (call, sub, claims, tag) => Promise.all([
  call(sub, `insert into consolidation_runs(id, model, prompt) values ($1, 'm', $2)`,
    [crypto.randomUUID(), `session transcript ${tag}`], claims),
  call(sub, `insert into router_runs(id, session_key, model, prompt, response, kept)
             values ($1, 's1', 'm', $2, '{"memories":[{"statement":"said before"}]}', 1)`,
    [crypto.randomUUID(), `capture window ${tag}`], claims),
  call(sub, `insert into memory_injections(id, session_key, event, query)
             values ($1, 's1', 'UserPromptSubmit', $2)`, [crypto.randomUUID(), `typed ${tag}`], claims),
]);

const count = async (call, sub, table, claims) =>
  (await call(sub, `select count(*)::int n from ${table}`, [], claims))[0].n;

test('the conversation logs are the person’s, not their apps’', async t => {
  const {db, owner, other, call} = await database();
  try {
    await t.test('the server can still log as the hook, as an app, and as the browser', async () => {
      // logConsolidationRun, logRouterRun and logInjection run under whatever
      // token the caller presented. None of them may start failing.
      await writeAll(call, owner, hook, 'by hook');
      await writeAll(call, owner, app, 'by app');
      await writeAll(call, owner, {}, 'by browser');
    });

    await t.test('the browser reads every row, which is what the Activity page needs', async () => {
      for (const table of ['consolidation_runs', 'router_runs', 'memory_injections'])
        assert.equal(await count(call, owner, table, {}), 3, table);
    });

    await t.test('an app reads no consolidation prompt and no typed query, not even its own', async () => {
      for (const claims of [hook, app]) {
        assert.equal(await count(call, owner, 'consolidation_runs', claims), 0);
        assert.equal(await count(call, owner, 'memory_injections', claims), 0);
      }
    });

    await t.test('an app reads back the capture runs it wrote, and only those', async () => {
      // capturedThisSession's query, under the hook's own token. Without its
      // own rows the router is never told what it already said and saves the
      // same thing twice.
      const mine = await call(owner,
        `select prompt, response from router_runs where session_key = 's1' and kept > 0`, [], hook);
      assert.deepEqual(mine.map(r => r.prompt), ['capture window by hook']);
      assert.match(mine[0].response, /said before/);
      const theirs = await call(owner, 'select prompt from router_runs', [], app);
      assert.deepEqual(theirs.map(r => r.prompt), ['capture window by app']);
    });

    await t.test('which connection wrote a run is the token’s to say, not the caller’s', async () => {
      await assert.rejects(call(owner,
        `insert into router_runs(id, session_key, model, prompt, client_id)
         values ($1, 's1', 'm', 'forged', 'satchel-hooks')`, [crypto.randomUUID()], app), {code: '42501'});
      await assert.rejects(call(owner,
        `update router_runs set client_id = 'claude-ai'`, [], app), {code: '42501'});
    });

    await t.test('runs logged before this change are the browser’s alone', async () => {
      // An old row has no client_id. It must not become readable by every app.
      await db.query(`insert into router_runs(id, owner_id, session_key, model, prompt)
                      values ($1, $2, 's0', 'm', 'from before')`, [crypto.randomUUID(), owner]);
      for (const claims of [hook, app])
        assert.deepEqual(await call(owner, `select id from router_runs where session_key = 's0'`, [], claims), []);
      assert.equal((await call(owner, `select id from router_runs where session_key = 's0'`, [], {})).length, 1);
    });

    await t.test('nobody else reads any of it, by browser or by app', async () => {
      for (const table of ['consolidation_runs', 'router_runs', 'memory_injections'])
        for (const claims of [{}, {...app}, {...hook}])
          assert.equal(await count(call, other, table, claims), 0, table);
    });

    await t.test('anonymous gets nothing', async () => {
      for (const table of ['consolidation_runs', 'router_runs', 'memory_injections']) {
        await db.exec('begin; set local role anon;');
        try { await assert.rejects(db.query(`select * from ${table}`), {code: '42501'}); }
        finally { await db.exec('rollback'); }
      }
    });
  } finally {
    await db.close();
  }
});
