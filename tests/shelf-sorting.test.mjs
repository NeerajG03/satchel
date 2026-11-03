import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './helpers/migrations.mjs';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const topic = '20000000-0000-4000-8000-000000000001';
const bobTopic = '20000000-0000-4000-8000-000000000002';
const item = '40000000-0000-4000-8000-000000000001';

test('sorting a Shelf item and deciding its suggestions', async t => {
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
  const suggestions = JSON.stringify([
    { kind: 'todo', title: 'Send Priya the pricing deck', due_date: '2026-11-07', source: 'send her the latest numbers by Friday', profile: 'work' },
    { kind: 'event', title: 'Dentist', starts_at: '2026-11-10T09:30:00Z', ends_at: '2026-11-10T10:00:00Z', source: 'call the dentist on Tuesday' },
  ]);
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
    await as(alice, 'select * from create_topic($1,$2,$3)', [topic, 'Pricing', 'The pricing work']);
    await as(alice, 'select set_topic_profile($1,$2)', [topic, 'work']);
    await as(bob, 'select * from create_topic($1,$2,$3)', [bobTopic, 'Bob only', 'Not Alice']);
    await as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6)', [item, 'note', 'send Priya the deck', null, null, null]);

    await t.test('the sorting context shows only your topics, with their profile', async () => {
      const [{ shelf_sort_context: context }] = await as(alice, 'select shelf_sort_context()');
      assert.deepEqual(context.topics.map(x => [x.name, x.profile]), [['Pricing', 'work']]);
    });

    await t.test('sorting saves the profile, topic, transcript and suggestions once', async () => {
      const [{ save_shelf_sorting: added }] = await as(alice, 'select save_shelf_sorting($1,$2,$3,$4,$5::jsonb)',
        [item, 'personal', topic, 'the words', suggestions]);
      assert.equal(added, 2);
      const [again] = await as(alice, 'select save_shelf_sorting($1,$2,$3,$4,$5::jsonb)', [item, 'personal', topic, 'x', suggestions]);
      assert.equal(again.save_shelf_sorting, 0, 'a retry adds nothing');
      const list = await as(alice, 'select * from list_shelf_suggestions()');
      assert.deepEqual(list.map(x => [x.kind, x.profile]), [['todo', 'work'], ['event', 'personal']]);
      assert.equal((await as(alice, 'select profile from list_shelf_items(10)'))[0].profile, 'personal');
    });

    await t.test('the person’s own profile choice is not overwritten, and a stranger’s topic is ignored', async () => {
      const second = '40000000-0000-4000-8000-000000000002';
      await as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6)', [second, 'note', 'buy milk', null, null, null]);
      await as(alice, 'select set_shelf_profile($1,$2)', [second, 'personal']);
      await as(alice, 'select save_shelf_sorting($1,$2,$3,$4,$5::jsonb)', [second, 'work', bobTopic, null, '[]']);
      const row = (await db.query(`select profile, topic_id from shelf_items where id = '${second}'`)).rows[0];
      assert.deepEqual(row, { profile: 'personal', topic_id: null });
    });

    await t.test('dismissing and adding decide once', async () => {
      const [todo, event] = await as(alice, 'select * from list_shelf_suggestions()');
      await as(alice, 'select * from decide_shelf_suggestion($1,$2)', [todo.id, 'dismissed']);
      assert.equal(await hint(as(alice, 'select * from decide_shelf_suggestion($1,$2)', [todo.id, 'added'])), 'satchel:gone:suggestion');
      await as(alice, 'select * from decide_shelf_suggestion($1,$2,$3,$4)', [event.id, 'added', 'work', 'https://calendar.google.com/x']);
      assert.deepEqual(await as(alice, 'select * from list_shelf_suggestions()'), []);
      assert.equal((await as(alice, 'select * from read_shelf_suggestion($1)', [event.id]))[0].profile, 'work');
      assert.equal(await hint(as(alice, 'select * from decide_shelf_suggestion($1,$2)', [event.id, 'maybe'])), 'satchel:invalid:suggestion');
    });

    await t.test('another person, an app token and anonymous get nothing', async () => {
      assert.equal(await hint(as(bob, 'select save_shelf_sorting($1,$2,$3,$4,$5::jsonb)', [item, 'work', null, null, '[]'])), 'satchel:gone:shelf_item');
      assert.deepEqual(await as(bob, 'select * from list_shelf_suggestions()'), []);
      assert.equal(await hint(as(alice, 'select * from list_shelf_suggestions()', [], { client_id: 'app' })), 'satchel:app_token');
      assert.match(await hint(as(null, 'select * from list_shelf_suggestions()')), /permission denied/);
      assert.match(await hint(as(alice, 'select * from shelf_suggestions')), /permission denied/);
    });

    await t.test('removing the item takes its suggestions and its words with it', async () => {
      await as(alice, 'select record_document_turn($1,$2,$3)', [`shelf-${item}`, 'user', 'send Priya the deck']);
      await as(bob, 'select record_document_turn($1,$2,$3)', [`shelf-${item}`, 'user', 'bob has a record with the same key']);
      await as(alice, 'select * from remove_shelf_item($1)', [item]);
      const left = (await db.query(`select owner_id from documents where session_key = 'shelf-${item}'`)).rows.map(r => r.owner_id);
      assert.deepEqual(left, [bob], 'only the remover’s record goes');
      assert.equal((await db.query(`select count(*)::int n from shelf_suggestions where item_id = '${item}'`)).rows[0].n, 0);
    });
  } finally { await db.close(); }
});
