import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const project = '20000000-0000-4000-8000-000000000001';
const projectMemory = '30000000-0000-4000-8000-000000000001';
const personalMemory = '30000000-0000-4000-8000-000000000002';

test('personal and project memories share operations without mixing scopes or owners', async t => {
  const db = new PGlite();
  async function asUser(id, sql, params = [], clientId) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, ...(clientId ? { client_id: clientId } : {}) })]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  const save = (owner, id, scope, name, description, details = '') =>
    asUser(owner, 'select * from save_memory($1,$2,$3,$4,$5)', [id, scope, name, description, details]);
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth, public to anon, authenticated;
      insert into auth.users values ('${alice}'), ('${bob}');
    `);
    const migrations = new URL('../supabase/migrations/', import.meta.url);
    const files = (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort();
    const personalMigration = files.indexOf('202609110002_personal_memory.sql');
    for (const file of files.slice(0, personalMigration)) await db.exec(await readFile(new URL(file, migrations), 'utf8'));
    await asUser(alice, 'select * from create_project($1,$2,$3)', [project, 'Existing project', 'Keep existing data']);
    const [before] = await save(alice, projectMemory, project, 'preferences', 'Project description', 'Project-only details');
    for (const file of files.slice(personalMigration)) await db.exec(await readFile(new URL(file, migrations), 'utf8'));

    await t.test('migration preserves every existing project field and revision', async () => {
      const [after] = await asUser(alice, 'select * from read_memory($1,$2)', [project, 'preferences']);
      assert.deepEqual(after, before);
      assert.deepEqual(await asUser(alice, 'select * from list_memories(null)'), []);
    });
    await t.test('a user with zero projects can save, retry and read personal memory', async () => {
      assert.deepEqual(await asUser(bob, 'select * from projects'), []);
      const args = [bob, personalMemory, null, 'preferences', 'Personal description', 'Personal-only details'];
      const [saved] = await save(...args);
      const [retried] = await save(...args);
      assert.equal(saved.id, retried.id); assert.equal(retried.revision, 1);
      assert.equal(saved.project_id, null);
      const [read] = await asUser(bob, 'select * from read_memory(null,$1)', [' PREFERENCES ']);
      assert.equal(read.more_info, 'Personal-only details');
      const [summary] = await asUser(bob, 'select * from list_memories(null)');
      assert.equal(summary.id, personalMemory); assert.equal('more_info' in summary, false);
      assert.deepEqual(await asUser(bob, 'select * from projects'), []);
    });
    await t.test('same name works across personal/project scopes and different owners', async () => {
      const [personal] = await save(alice, crypto.randomUUID(), null, 'preferences', 'Alice personal', 'Alice-only personal details');
      const [personalRead] = await asUser(alice, 'select * from read_memory(null,$1)', ['preferences']);
      const [projectRead] = await asUser(alice, 'select * from read_memory($1,$2)', [project, 'preferences']);
      assert.equal(personalRead.id, personal.id); assert.equal(projectRead.id, projectMemory);
      assert.notEqual(personalRead.more_info, projectRead.more_info);
      assert.deepEqual((await asUser(alice, 'select * from list_memories(null)')).map(m => m.id), [personal.id]);
      assert.deepEqual((await asUser(alice, 'select * from list_memories($1)', [project])).map(m => m.id), [projectMemory]);
      await assert.rejects(save(alice, crypto.randomUUID(), null, ' PREFERENCES ', 'Duplicate personal'), { code: '23505' });
      await assert.rejects(save(alice, crypto.randomUUID(), project, 'PREFERENCES', 'Duplicate project'), { code: '23505' });
    });
    await t.test('scope is immutable and an ID cannot be reused to move or leak a record', async () => {
      await assert.rejects(asUser(alice, 'update memories set project_id=null where id=$1', [projectMemory]), { code: '42501' });
      await assert.rejects(save(alice, projectMemory, null, 'preferences', 'Project description', 'Project-only details'), { code: 'PT409' });
      await assert.rejects(save(bob, crypto.randomUUID(), project, 'foreign-project', 'Denied'), { code: '23503' });
      await assert.rejects(save(alice, personalMemory, null, 'stolen', 'Denied'), { code: 'PT409' });
    });
    await t.test('personal records retain owner isolation and deny unapproved agent access', async () => {
      assert.deepEqual(await asUser(alice, 'select * from memories where id=$1', [personalMemory]), []);
      assert.deepEqual(await asUser(alice, 'delete from memories where id=$1 returning id', [personalMemory]), []);
      await assert.rejects(asUser(alice, 'select * from correct_memory($1,1,$2,$3,$4)', [personalMemory, 'tampered', 'tampered', 'tampered']), { code: 'PT409' });
      assert.deepEqual(await asUser(bob, 'select * from list_memories(null)', [], 'unapproved-agent'), []);
      await assert.rejects(asUser(bob, 'select * from read_memory(null,$1)', ['preferences'], 'unapproved-agent'), { code: 'P0002' });
      await assert.rejects(asUser(bob, 'select * from save_memory($1,null,$2,$3,$4)', [crypto.randomUUID(), 'agent', 'Denied', ''], 'unapproved-agent'), { code: '42501' });
    });
    await t.test('personal correction and rename enforce expected revisions', async () => {
      const [row] = await asUser(bob, 'select * from correct_memory($1,1,$2,$3,$4)', [personalMemory, 'writing-preferences', 'Updated personal description', 'Updated personal details']);
      assert.equal(row.revision, 2); assert.equal(row.project_id, null);
      await assert.rejects(asUser(bob, 'select * from correct_memory($1,1,$2,$3,$4)', [personalMemory, 'stale', 'stale', 'stale']), { code: 'PT409' });
      await assert.rejects(asUser(bob, 'select * from read_memory(null,$1)', ['preferences']), { code: 'P0002' });
      assert.equal((await asUser(bob, 'select * from read_memory(null,$1)', ['writing-preferences']))[0].more_info, 'Updated personal details');
    });
    await t.test('deleting personal memory checks revisions without affecting project memory', async () => {
      assert.deepEqual(await asUser(bob, 'delete from memories where id=$1 and revision=1 returning id', [personalMemory]), []);
      assert.equal((await asUser(bob, 'delete from memories where id=$1 and revision=2 returning id', [personalMemory])).length, 1);
      assert.deepEqual(await asUser(bob, 'select * from list_memories(null)'), []);
      assert.equal((await asUser(alice, 'select * from read_memory($1,$2)', [project, 'preferences']))[0].more_info, 'Project-only details');
    });
    await t.test('anonymous access cannot list personal summaries', async () => {
      await db.exec('begin; set local role anon;');
      await assert.rejects(db.query('select * from list_memories(null)'), { code: '42501' });
      await db.exec('rollback');
    });
  } finally { await db.close(); }
});
