// A save the person makes with one button lands whole or not at all. These
// used to be two or more calls from the page, and a refusal between them left
// the first part saved under an error that said nothing was.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';
import {SUPABASE_STORAGE} from './helpers/storage.mjs';

test('one button, one transaction', async t => {
  const db = new PGlite();
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  async function call(claims, sql, params = []) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  await db.exec(`create role anon;create role authenticated;create role supabase_auth_admin;
    create schema auth;${SUPABASE_STORAGE}create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    insert into auth.users values('${owner}'),('${other}');`);
  await applyMigrations(db);
  const user = {sub: owner};

  await t.test('a taken short name leaves no topic behind', async () => {
    await call(user, 'select create_topic($1,$2,$3,$4)', [crypto.randomUUID(), 'Launch', '', 'web-launch']);
    const second = crypto.randomUUID();
    await assert.rejects(call(user, 'select create_topic($1,$2,$3,$4)', [second, 'Launch again', '', 'web-launch']),
      /That slug is already in use/);
    assert.deepEqual(await call(user, 'select id from topics where id=$1', [second]), []);
    const [made] = await call(user, 'select * from create_topic($1,$2,$3,$4)', [second, 'Launch again', '', 'launch-two']);
    assert.equal(made.slug, 'launch-two');
  });

  await t.test('the short name is set in the same call, and a retry is the same topic', async () => {
    const id = crypto.randomUUID();
    const args = [id, 'Billing work', 'Invoices', 'billing'];
    const [first] = await call(user, 'select * from create_topic($1,$2,$3,$4)', args);
    const [again] = await call(user, 'select * from create_topic($1,$2,$3,$4)', args);
    assert.equal(first.slug, 'billing');
    assert.equal(again.id, first.id);
    assert.equal((await call(user, 'select count(*)::int n from topics where name=$1', ['Billing work']))[0].n, 1);
  });

  await t.test('no short name keeps the derived one, as before', async () => {
    const [made] = await call(user, 'select * from create_topic($1,$2,$3)', [crypto.randomUUID(), 'Plain Topic', '']);
    assert.equal(made.slug, 'plain-topic');
  });

  await t.test('another person cannot set a short name on my topic through create', async () => {
    const [{id}] = await call(user, 'select id from topics where slug=$1', ['billing']);
    await assert.rejects(call({sub: other}, 'select create_topic($1,$2,$3,$4)', [id, 'Billing work', 'Invoices', 'mine-now']));
    assert.equal((await call(user, 'select slug from topics where id=$1', [id]))[0].slug, 'billing');
  });

  await t.test('anonymous cannot call it', async () => {
    await db.exec('begin; set local role anon;');
    await assert.rejects(db.query("select create_topic($1,'x','','x')", [crypto.randomUUID()]), /permission denied/);
    await db.exec('rollback');
  });
});
