import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, migrationFiles } from './helpers/migrations.mjs';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const MIGRATION = '20261108100000_integrations.sql';

test('connections and slots are the owner’s, from the web app only, and old Google links move over', async t => {
  const db = new PGlite();
  async function as(id, sql, params = [], extra = {}) {
    await db.exec(`begin; set local role ${id ? 'authenticated' : 'anon'};`);
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(id ? { sub: id, ...extra } : {})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  const hint = async promise => { try { await promise; } catch (e) { return e.hint ?? e.message; } return 'no error'; };
  try {
    await db.exec(`
      create role anon; create role authenticated; create role supabase_auth_admin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth, public to anon, authenticated;
      insert into auth.users values ('${alice}'), ('${bob}');
    `);
    const all = await migrationFiles();
    await applyMigrations(db, { through: all[all.indexOf(MIGRATION) - 1] });
    const sealed = 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccc';
    // Alice linked one account to both profiles; Bob linked a work account.
    await as(alice, 'select save_google_link($1,$2,$3,$4)', ['personal', 'me@gmail.com', sealed, 's']);
    await as(alice, 'select save_google_link($1,$2,$3,$4)', ['work', 'me@gmail.com', sealed + 'w', 's']);
    await as(bob, 'select save_google_link($1,$2,$3,$4)', ['work', 'bob@work.com', sealed, 's']);
    await applyMigrations(db, { files: [MIGRATION] });

    await t.test('each Google link became one connection and both slots of its profile', async () => {
      const connections = await as(alice, 'select * from list_connections()');
      assert.deepEqual(connections.map(c => [c.provider, c.label]), [['google', 'me@gmail.com']]);
      assert.equal('token_cipher' in connections[0], false);
      const slots = await as(alice, 'select profile, slot, plugin from list_destinations()');
      assert.deepEqual(slots.map(s => `${s.profile}/${s.slot}/${s.plugin}`).sort(),
        ['personal/event/google_calendar', 'personal/todo/google_tasks', 'work/event/google_calendar', 'work/todo/google_tasks']);
      const token = (await as(alice, 'select * from connection_token($1)', [connections[0].id]))[0];
      assert.deepEqual([token.token_cipher, token.seal_tag], [sealed, 'personal'], 'the personal token is kept, still sealed to its profile');
      assert.deepEqual((await as(alice, 'select profile from google_link_status()')).map(r => r.profile).sort(), ['personal', 'work']);
    });

    let notion;
    await t.test('connect Notion, point Work’s to-dos at it, and read the slot back for the server', async () => {
      notion = (await as(alice, 'select save_connection($1,$2,$3,$4,$5,$6,$7) id',
        ['notion', 'ws-1', 'Different', sealed, 'notion:ws-1', '', { user_id: 'u-1' }]))[0].id;
      const again = (await as(alice, 'select save_connection($1,$2,$3,$4,$5,$6,$7) id',
        ['notion', 'ws-1', 'Different HQ', sealed + 'x', 'notion:ws-1', '', {}]))[0].id;
      assert.equal(again, notion, 'signing in to the same workspace again keeps the same connection');
      await as(alice, 'select set_destination($1,$2,$3,$4,$5)', ['work', 'todo', 'notion_database', notion, { data_source_id: 'ds' }]);
      const slot = (await as(alice, 'select * from destination_for($1,$2)', ['work', 'todo']))[0];
      assert.deepEqual([slot.plugin, slot.provider, slot.settings.data_source_id, slot.token_cipher], ['notion_database', 'notion', 'ds', sealed + 'x']);
      await as(alice, 'select update_connection_token($1,$2)', [notion, sealed + 'y']);
      assert.equal((await as(alice, 'select * from connection_token($1)', [notion]))[0].token_cipher, sealed + 'y');
    });

    await t.test('a plugin must match its account, and Google Tasks holds no events', async () => {
      const google = (await as(alice, "select id from list_connections() where provider = 'google'"))[0].id;
      assert.equal(await hint(as(alice, 'select set_destination($1,$2,$3,$4)', ['work', 'todo', 'google_tasks', notion])), 'satchel:invalid:plugin');
      assert.equal(await hint(as(alice, 'select set_destination($1,$2,$3,$4)', ['work', 'todo', 'notion_database', google])), 'satchel:invalid:plugin');
      assert.equal(await hint(as(alice, 'select set_destination($1,$2,$3,$4)', ['work', 'event', 'google_tasks', google])), 'satchel:invalid:plugin');
      assert.equal(await hint(as(alice, 'select set_destination($1,$2,$3,$4)', ['side', 'todo', 'google_tasks', google])), 'satchel:invalid:profile');
      assert.equal(await hint(as(alice, 'select set_destination($1,$2,$3,$4)', ['work', 'note', 'google_tasks', google])), 'satchel:invalid:slot');
      assert.equal(await hint(as(alice, 'select save_connection($1,$2,$3,$4,$5)', ['slack', 'a', 'b', sealed, 't'])), 'satchel:invalid:provider');
      await as(alice, 'select set_destination($1,$2,$3)', ['personal', 'todo', null]);
      assert.equal(await hint(as(alice, 'select * from destination_for($1,$2)', ['personal', 'todo'])), 'satchel:gone:destination');
    });

    await t.test('another person, an app token and anonymous get nothing', async () => {
      assert.equal(await hint(as(bob, 'select * from connection_token($1)', [notion])), 'satchel:gone:connection');
      assert.equal(await hint(as(bob, 'select update_connection_token($1,$2)', [notion, sealed])), 'satchel:gone:connection');
      assert.equal(await hint(as(bob, 'select set_destination($1,$2,$3,$4)', ['work', 'todo', 'notion_database', notion])), 'satchel:gone:connection');
      assert.deepEqual(await as(bob, 'select * from remove_connection($1)', [notion]), []);
      assert.deepEqual((await as(bob, 'select label from list_connections()')).map(c => c.label), ['bob@work.com']);
      assert.equal(await hint(as(alice, 'select * from list_connections()', [], { client_id: 'app' })), 'satchel:app_token');
      assert.equal(await hint(as(alice, 'select * from destination_for($1,$2)', ['work', 'todo'], { client_id: 'app' })), 'satchel:app_token');
      assert.match(await hint(as(null, 'select * from list_connections()')), /permission denied/);
      assert.match(await hint(as(alice, 'select * from connections')), /permission denied/);
      assert.match(await hint(as(alice, 'select * from destinations')), /permission denied/);
    });

    await t.test('disconnecting hands back the sealed token once and empties its slots', async () => {
      assert.equal((await as(alice, 'select * from remove_connection($1)', [notion]))[0].token_cipher, sealed + 'y');
      assert.deepEqual(await as(alice, 'select * from remove_connection($1)', [notion]), []);
      assert.equal(await hint(as(alice, 'select * from destination_for($1,$2)', ['work', 'todo'])), 'satchel:gone:destination');
    });
  } finally { await db.close(); }
});
