import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const project = '20000000-0000-4000-8000-000000000001';
const otherProject = '20000000-0000-4000-8000-000000000002';
const memory = '30000000-0000-4000-8000-000000000001';

test('foundation migration enforces account isolation and write semantics', async t => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    insert into auth.users values ('${alice}'), ('${bob}');
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/202609100001_foundation.sql', import.meta.url), 'utf8'));
  async function asUser(id, sql, params = [], clientId) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, ...(clientId ? { client_id: clientId } : {}) })]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  try {
    await asUser(alice, 'select * from public.create_project($1,$2,$3)', [project, 'Satchel', 'An ongoing effort']);
    await asUser(bob, 'select * from public.create_project($1,$2,$3)', [otherProject, 'Satchel', 'Separate owner']);
    await t.test('same names do not share data', async () => {
      const rows = await asUser(alice, 'select * from projects');
      assert.equal(rows.length, 1); assert.equal(rows[0].id, project);
    });
    await t.test('retries do not duplicate an explicit save', async () => {
      const args = [memory, project, 'Projects may contain multiple repositories.'];
      await asUser(alice, 'select * from save_memory($1,$2,$3)', args);
      const retry = await asUser(alice, 'select * from save_memory($1,$2,$3)', args);
      assert.equal(retry[0].revision, 1);
      assert.equal((await asUser(alice, 'select * from memories')).length, 1);
    });
    await t.test('another owner cannot retrieve, correct, delete or reuse a memory ID', async () => {
      assert.deepEqual(await asUser(bob, 'select * from memories where id=$1', [memory]), []);
      await assert.rejects(asUser(bob, 'select * from correct_memory($1,1,$2)', [memory, 'tampered']), { code: '40001' });
      assert.deepEqual(await asUser(bob, 'delete from memories where id=$1 returning id', [memory]), []);
      await assert.rejects(asUser(bob, 'select * from save_memory($1,$2,$3)', [memory, otherProject, 'copied']), { code: '40001' });
    });
    await t.test('cannot save in another owner’s project', async () => {
      await assert.rejects(asUser(bob, 'select * from save_memory($1,$2,$3)', ['30000000-0000-4000-8000-000000000002', project, 'wrong project']), { code: '23503' });
    });
    await t.test('corrections use expected revision and preserve the winning write', async () => {
      const rows = await asUser(alice, 'select * from correct_memory($1,1,$2)', [memory, 'Projects may also have no repository.']);
      assert.equal(rows[0].revision, 2);
      await assert.rejects(asUser(alice, 'select * from correct_memory($1,1,$2)', [memory, 'stale edit']), { code: '40001' });
      assert.equal((await asUser(alice, 'select body from memories'))[0].body, 'Projects may also have no repository.');
    });
    await t.test('same id with different payload cannot overwrite a saved record', async () => {
      await assert.rejects(asUser(alice, 'select * from save_memory($1,$2,$3)', [memory, project, 'overwritten']), { code: '40001' });
    });
    await t.test('agent tokens are denied until connection grants are implemented', async () => {
      assert.deepEqual(await asUser(alice, 'select * from memories', [], 'unapproved-client'), []);
      assert.deepEqual(await asUser(alice, 'select * from projects', [], 'unapproved-client'), []);
      await assert.rejects(asUser(alice, 'select * from save_memory($1,$2,$3)', ['30000000-0000-4000-8000-000000000003', project, 'agent write'], 'unapproved-client'), { code: '42501' });
    });
    await t.test('empty records and forged metadata are rejected', async () => {
      await assert.rejects(asUser(alice, 'select * from save_memory($1,$2,$3)', ['30000000-0000-4000-8000-000000000004', project, '   ']), { code: '23514' });
      await assert.rejects(asUser(alice, 'update memories set revision=100 where id=$1', [memory]), { code: '42501' });
      await assert.rejects(asUser(alice, 'update memories set owner_id=$1 where id=$2', [bob, memory]), { code: '42501' });
    });
    await t.test('anonymous requests have no data access', async () => {
      await db.exec('begin; set local role anon;');
      await assert.rejects(db.query('select * from memories'), { code: '42501' });
      await db.exec('rollback');
    });
    await t.test('deletion checks the revision and removes the current record', async () => {
      assert.deepEqual(await asUser(alice, 'delete from memories where id=$1 and revision=1 returning id', [memory]), []);
      assert.equal((await asUser(alice, 'delete from memories where id=$1 and revision=2 returning id', [memory])).length, 1);
      assert.deepEqual(await asUser(alice, 'select * from memories'), []);
    });
  } finally { await db.close(); }
});
