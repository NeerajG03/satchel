import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './helpers/migrations.mjs';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const topic = '20000000-0000-4000-8000-000000000001';
const item = '40000000-0000-4000-8000-000000000001';

test('profiles are the owner’s, from the web app only', async t => {
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
    await applyMigrations(db);
    await as(alice, 'select * from create_topic($1,$2,$3)', [topic, 'Satchel', 'Memory across apps']);

    await t.test('both profiles appear on first look, once', async () => {
      const first = await as(alice, 'select * from list_profiles()');
      const again = await as(alice, 'select * from list_profiles()');
      assert.deepEqual(first.map(p => p.kind), ['personal', 'work']);
      assert.deepEqual(again.map(p => p.kind), ['personal', 'work']);
    });

    await t.test('a topic is tagged, moved and untagged', async () => {
      await as(alice, 'select set_topic_profile($1,$2)', [topic, 'work']);
      assert.deepEqual(await as(alice, 'select * from topic_profile_list()'), [{ topic_id: topic, kind: 'work' }]);
      assert.equal((await as(alice, 'select * from list_profiles()')).find(p => p.kind === 'work').topics, 1);
      await as(alice, 'select set_topic_profile($1,$2)', [topic, 'personal']);
      assert.equal((await as(alice, 'select * from topic_profile_list()'))[0].kind, 'personal');
      await as(alice, 'select set_topic_profile($1,$2)', [topic, null]);
      assert.deepEqual(await as(alice, 'select * from topic_profile_list()'), []);
      assert.equal(await hint(as(alice, 'select set_topic_profile($1,$2)', [topic, 'side-project'])), 'satchel:invalid:profile');
    });

    await t.test('another person cannot tag your topic or see your tags', async () => {
      await as(alice, 'select set_topic_profile($1,$2)', [topic, 'work']);
      assert.equal(await hint(as(bob, 'select set_topic_profile($1,$2)', [topic, 'personal'])), 'satchel:gone:topic');
      assert.deepEqual(await as(bob, 'select * from topic_profile_list()'), []);
      assert.equal((await as(alice, 'select * from topic_profile_list()'))[0].kind, 'work');
    });

    await t.test('a shelf item takes a profile, and lists say which', async () => {
      await as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6)', [item, 'note', 'call the dentist', null, null, null]);
      await as(alice, 'select set_shelf_profile($1,$2)', [item, 'personal']);
      assert.equal((await as(alice, 'select profile from list_shelf_items(10)'))[0].profile, 'personal');
      assert.equal(await hint(as(bob, 'select set_shelf_profile($1,$2)', [item, 'work'])), 'satchel:gone:shelf_item');
    });

    await t.test('the timezone is kept on both profiles', async () => {
      await as(alice, 'select set_profile_timezone($1)', ['Asia/Kolkata']);
      assert.deepEqual((await as(alice, 'select timezone from list_profiles()')).map(p => p.timezone), ['Asia/Kolkata', 'Asia/Kolkata']);
    });

    await t.test('a merged topic hands its profile on and stops being counted', async () => {
      const other = '20000000-0000-4000-8000-000000000002';
      await as(alice, 'select * from create_topic($1,$2,$3)', [other, 'Web app', 'The site']);
      await as(alice, 'select set_topic_profile($1,$2)', [topic, 'work']);
      await db.exec(`update topics set merged_into = '${other}' where id = '${topic}'`);
      const tags = Object.fromEntries((await as(alice, 'select * from topic_profile_list()')).map(r => [r.topic_id, r.kind]));
      assert.equal(tags[other], 'work');
      assert.equal((await as(alice, 'select * from list_profiles()')).find(p => p.kind === 'work').topics, 1);
    });

    await t.test('a deleted topic takes its tag with it, and a bad timezone is refused', async () => {
      const gone = '20000000-0000-4000-8000-000000000003';
      await as(alice, 'select * from create_topic($1,$2,$3)', [gone, 'Old', 'Going']);
      await as(alice, 'select set_topic_profile($1,$2)', [gone, 'personal']);
      await db.exec(`delete from topics where id = '${gone}'`);
      assert.equal((await as(alice, 'select * from topic_profile_list()')).some(r => r.topic_id === gone), false);
      assert.equal(await hint(as(alice, 'select set_profile_timezone($1)', [''])), 'satchel:invalid:timezone');
    });

    await t.test('an app token and the anonymous role get nothing', async () => {
      assert.equal(await hint(as(alice, 'select * from list_profiles()', [], { client_id: 'app' })), 'satchel:app_token');
      assert.match(await hint(as(null, 'select * from list_profiles()')), /permission denied/);
      assert.match(await hint(as(alice, 'select * from profiles')), /permission denied/);
    });
  } finally { await db.close(); }
});
