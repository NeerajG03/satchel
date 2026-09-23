// An agent's forget ends a memory; it never destroys one.
//
// forget_memory used to be delete_memory, and it ran a real DELETE, which took
// the row and its memory_events history with it while the web app's Forget
// and consolidation had both learned to end rows instead. So this goes all the
// way through: the MCP tool, the real service, and the real migrations in
// PGlite under an agent token, because the service tests drive a fake database
// and the database tests never go through the service. The fake below has no
// delete at all, so a service that tried one would fail here too.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {applyMigrations} from './helpers/migrations.mjs';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {memoryService} from '../server/memory-service.mjs';

/** Just enough of supabase-js for the forget path, run as the given claims. */
function client(db, claims) {
  async function run(sql, params) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      const found = await db.query(sql, params);
      await db.exec('commit');
      return {data:found, error:null};
    } catch (error) { await db.exec('rollback'); return {data:null, error}; }
  }
  return {
    rpc(name, args = {}) {
      const keys = Object.keys(args);
      const sql = `select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      // A scalar comes back bare and a row comes back as an object, as PostgREST returns them.
      return {abortSignal: () => run(sql, keys.map(k => args[k])).then(({data, error}) => error ? {data:null, error} : {
        data: data.fields.length === 1 && data.fields[0].name === name ? data.rows[0]?.[name] : data.rows[0] ?? null,
        error:null})};
    },
    from(table) {
      const where = [], params = [];
      let columns = '*';
      const query = {
        select(list) { columns = list; return query; },
        eq(column, value) { params.push(value); where.push(`${column} = $${params.length}`); return query; },
        is(column, value) { assert.equal(value, null); where.push(`${column} is null`); return query; },
        abortSignal: () => run(`select ${columns} from public.${table} where ${where.join(' and ')}`, params)
          .then(({data, error}) => ({data:error ? null : data.rows, error})),
      };
      return query;
    },
  };
}

test('an agent forgets a memory by ending it, and the person can bring it back', async t => {
  const db = new PGlite();
  const owner = crypto.randomUUID(), project = crypto.randomUUID(), memory = crypto.randomUUID();
  const person = {sub:owner};
  async function call(claims, sql, params = []) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      const found = await db.query(sql, params);
      await db.exec('commit');
      return found.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  async function claims(clientId) {
    const {rows} = await db.query('select satchel_access_token_hook($1) result',
      [{user_id:owner, client_id:clientId, claims:{sub:owner, client_id:clientId, aud:'authenticated'}}]);
    return rows[0].result.claims;
  }
  async function connect(clientId) {
    const server = createMemoryServer(memoryService(client(db, await claims(clientId))));
    const mcp = new Client({name:'test', version:'1'});
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right); await mcp.connect(left);
    return async args => {
      const reply = await mcp.callTool({name:'forget_memory', arguments:args});
      return {error:reply.isError === true, body:JSON.parse(reply.content[0].text)};
    };
  }
  const row = async () => (await call(person,
    'select ended_at, ended_reason, revision from memories where id=$1', [memory]))[0];
  const history = async () => call(person, 'select action, actor from memory_history($1)', [memory]);
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
      insert into auth.users values('${owner}');
    `);
    await applyMigrations(db);
    await call(person, 'select create_project($1,$2,$3)', [project, 'Ledger', '']);
    await call(person, 'select save_memory($1,$2,$3,$4,$5,$6,$7)',
      [memory, project, 'Entries are immutable.', 'entries are immutable', 'said', null, '']);
    await call(person, 'select authorize_agent($1,$1,$2,$3,$4)', ['forget-writer', true, [project], true]);
    await call(person, 'select authorize_agent($1,$1,$2,$3,$4)', ['forget-reader', true, [project], false]);
    const forget = await connect('forget-writer');

    await t.test('a stale revision is a conflict and changes nothing', async () => {
      const reply = await forget({project_id:project, id:memory, revision:2});
      assert.equal(reply.error, true);
      assert.match(reply.body.error, /changed since you read it.*current revision/);
      assert.equal((await row()).ended_at, null);
    });

    await t.test('the scope it names has to be the scope the memory is in', async () => {
      const reply = await forget({project_id:null, id:memory, revision:1});
      assert.equal(reply.error, true, 'personal write access does not reach a project memory by id');
      assert.match(reply.body.error, /changed since you read it.*current revision/);
      assert.equal((await row()).ended_at, null);
    });

    await t.test('a connection without write access is refused', async () => {
      const reply = await (await connect('forget-reader'))({project_id:project, id:memory, revision:1});
      assert.equal(reply.error, true);
      assert.match(reply.body.error, /may not write memories in that scope/);
      assert.equal((await row()).ended_at, null);
    });

    await t.test('forgetting ends the row as forgotten and keeps it', async () => {
      const reply = await forget({project_id:project, id:memory, revision:1});
      assert.equal(reply.error, false, JSON.stringify(reply.body));
      assert.deepEqual(reply.body, {forgotten_id:memory, revision:2});
      const after = await row();
      assert.ok(after, 'the row is still there');
      assert.notEqual(after.ended_at, null);
      assert.equal(after.ended_reason, 'forgotten');
      assert.deepEqual(await call(person, 'select id from list_memories($1)', [project]), [],
        'and it no longer loads');
      assert.deepEqual((await call(person, 'select id from archived_memories()')).map(r => r.id), [memory]);
    });

    await t.test('the history records the forget and who did it', async () => {
      assert.deepEqual(await history(), [
        {action:'added', actor:`user:${owner}`},
        {action:'forgotten', actor:'agent:forget-writer'},
      ]);
    });

    await t.test('forgetting it again is a conflict, not a second ending', async () => {
      const reply = await forget({project_id:project, id:memory, revision:2});
      assert.equal(reply.error, true);
      assert.match(reply.body.error, /changed since you read it.*current revision/);
    });

    await t.test('restore_memory brings it back', async () => {
      await call(person, 'select * from restore_memory($1,$2)', [memory, 2]);
      const after = await row();
      assert.equal(after.ended_at, null);
      assert.equal(after.ended_reason, null);
      assert.deepEqual((await call(person, 'select id from list_memories($1)', [project])).map(r => r.id), [memory]);
      assert.deepEqual((await history()).map(r => r.action), ['added', 'forgotten', 'restored']);
    });
  } finally { await db.close(); }
});
