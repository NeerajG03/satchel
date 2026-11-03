import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './helpers/migrations.mjs';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';

test('a Google link is the owner’s, per profile, from the web app only', async t => {
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
    const sealed = 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccc';

    await t.test('link, relink and read status without the token', async () => {
      await as(alice, 'select save_google_link($1,$2,$3,$4)', ['work', 'me@work.com', sealed, 'scopes']);
      await as(alice, 'select save_google_link($1,$2,$3,$4)', ['work', 'me2@work.com', sealed, 'scopes']);
      const status = await as(alice, 'select * from google_link_status()');
      assert.deepEqual(status.map(s => [s.profile, s.email]), [['work', 'me2@work.com']]);
      assert.equal('token_cipher' in status[0], false);
      assert.equal((await as(alice, 'select google_link_token($1) t', ['work']))[0].t, sealed);
      assert.equal(await hint(as(alice, 'select google_link_token($1)', ['personal'])), 'satchel:gone:google_link');
      assert.equal(await hint(as(alice, 'select save_google_link($1,$2,$3,$4)', ['side', 'x@y.z', sealed, ''])), 'satchel:invalid:profile');
    });

    await t.test('another person, an app token and anonymous get nothing', async () => {
      assert.deepEqual(await as(bob, 'select * from google_link_status()'), []);
      assert.equal(await hint(as(bob, 'select google_link_token($1)', ['work'])), 'satchel:gone:google_link');
      assert.equal(await hint(as(alice, 'select google_link_token($1)', ['work'], { client_id: 'app' })), 'satchel:app_token');
      assert.match(await hint(as(null, 'select * from google_link_status()')), /permission denied/);
      assert.match(await hint(as(alice, 'select * from google_links')), /permission denied/);
    });

    await t.test('unlinking hands back the sealed token once, then it is gone', async () => {
      assert.equal((await as(alice, 'select remove_google_link($1) t', ['work']))[0].t, sealed);
      assert.equal((await as(alice, 'select remove_google_link($1) t', ['work']))[0].t, null);
      assert.deepEqual(await as(alice, 'select * from google_link_status()'), []);
    });
  } finally { await db.close(); }
});
