import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const project = '20000000-0000-4000-8000-000000000001';
const secondProject = '20000000-0000-4000-8000-000000000002';
const bobProject = '20000000-0000-4000-8000-000000000003';
const legacyId = '30000000-0000-4000-8000-000000000001';
const memory = '30000000-0000-4000-8000-000000000002';
const legacyBody = 'An explicitly saved decision.\n' + 'Preserve the complete original text. '.repeat(40);

test('named memories preserve content and separate discovery from detail retrieval', async t => {
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
  const save = (id, scope, name, description = 'When to read this memory.', info = '') =>
    asUser(alice, 'select * from save_memory($1,$2,$3,$4,$5)', [id, scope, name, description, info]);
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
    await db.exec(await readFile(new URL('../supabase/migrations/202609100001_foundation.sql', import.meta.url), 'utf8'));
    await asUser(alice, 'select * from create_project($1,$2,$3)', [project, 'First project', '']);
    await asUser(alice, 'select * from create_project($1,$2,$3)', [secondProject, 'Second project', '']);
    await asUser(bob, 'select * from create_project($1,$2,$3)', [bobProject, 'Separate owner', '']);
    const [legacy] = await asUser(alice, 'select * from save_memory($1,$2,$3)', [legacyId, project, legacyBody]);
    await db.exec(await readFile(new URL('../supabase/migrations/202609100002_named_memories.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202609110001_conflict_responses.sql', import.meta.url), 'utf8'));

    await t.test('migration preserves existing IDs, scopes and complete text', async () => {
      const [row] = await asUser(alice, 'select * from read_memory($1,$2)', [project, `memory-${legacyId}`]);
      assert.equal(row.id, legacyId); assert.equal(row.project_id, project);
      assert.equal(row.more_info, legacy.body); assert.equal(row.description, legacy.body.slice(0, 280));
      assert.equal(row.revision, 2);
    });
    await t.test('summaries omit details and full content is read by a scoped name', async () => {
      const info = '  Detailed context\n' + 'Long details. '.repeat(500);
      await save(memory, project, 'Interview preparation', 'Read before planning interview practice.', info);
      const rows = await asUser(alice, 'select * from list_memories($1)', [project]);
      assert.equal(rows.length, 2);
      for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['id','project_id','name','description','revision','updated_at'].sort());
      const [full] = await asUser(alice, 'select * from read_memory($1,$2)', [project, '  INTERVIEW preparation  ']);
      assert.equal(full.more_info, info); assert.equal(full.id, memory);
      await save(memory, project, 'Interview preparation', 'Read before planning interview practice.', info);
      assert.equal((await asUser(alice, 'select * from read_memory($1,$2)', [project, 'Interview preparation']))[0].revision, 1);
    });
    await t.test('names are unique within a project but reusable in other scopes', async () => {
      await assert.rejects(save(crypto.randomUUID(), project, ' interview PREPARATION '), { code: '23505' });
      await save(crypto.randomUUID(), secondProject, 'Interview preparation');
      await asUser(bob, 'select * from save_memory($1,$2,$3,$4,$5)', [crypto.randomUUID(), bobProject, 'Interview preparation', 'Bob only.', 'Private details']);
      await assert.rejects(save(crypto.randomUUID(), bobProject, 'Unauthorized'), { code: '23503' });
    });
    await t.test('other owners and unapproved agents cannot list or read even known names', async () => {
      for (const [id, client] of [[bob, undefined], [alice, 'unapproved-agent']]) {
        assert.deepEqual(await asUser(id, 'select * from list_memories($1)', [project], client), []);
        await assert.rejects(asUser(id, 'select * from read_memory($1,$2)', [project, 'Interview preparation'], client), { code: 'P0002' });
        await assert.rejects(asUser(id, 'select * from correct_memory($1,1,$2,$3,$4)', [memory, 'Tampered', 'Tampered', 'Tampered'], client), { code: 'PT409' });
      }
      await assert.rejects(asUser(alice, 'select * from save_memory($1,$2,$3,$4,$5)', [crypto.randomUUID(), project, 'Agent write', 'Denied', ''], 'unapproved-agent'), { code: '42501' });
    });
    await t.test('retry conflicts include all three content fields', async () => {
      await assert.rejects(save(memory, project, 'Different name'), { code: 'PT409' });
      await assert.rejects(save(memory, project, 'Interview preparation', 'Different description'), { code: 'PT409' });
      await assert.rejects(save(memory, project, 'Interview preparation', 'Read before planning interview practice.', 'Different info'), { code: 'PT409' });
    });
    await t.test('name and description are required, more info is optional and bounded', async () => {
      await assert.rejects(save(crypto.randomUUID(), project, '  '), { code: '23514' });
      await assert.rejects(save(crypto.randomUUID(), project, 'Empty description', '  '), { code: '23514' });
      await assert.rejects(save(crypto.randomUUID(), project, 'Long description', 'a'.repeat(281)), { code: '23514' });
      await assert.rejects(save(crypto.randomUUID(), project, 'Long name'.repeat(20)), { code: '23514' });
      await assert.rejects(save(crypto.randomUUID(), project, 'Too much info', 'Summary', 'a'.repeat(40001)), { code: '23514' });
      const [row] = await save(crypto.randomUUID(), project, 'Summary only');
      assert.equal(row.more_info, '');
      await assert.rejects(asUser(alice, 'update memories set owner_id=$1 where id=$2', [bob, memory]), { code: '42501' });
      await assert.rejects(asUser(alice, 'update memories set revision=100 where id=$1', [memory]), { code: '42501' });
    });
    await t.test('correction refreshes the index, keeps identity, and detects stale writes', async () => {
      const [row] = await asUser(alice, 'select * from correct_memory($1,1,$2,$3,$4)', [memory, 'Practice plan', 'Updated summary', 'Updated details']);
      assert.equal(row.revision, 2); assert.equal(row.id, memory);
      await assert.rejects(asUser(alice, 'select * from read_memory($1,$2)', [project, 'Interview preparation']), { code: 'P0002' });
      assert.equal((await asUser(alice, 'select * from read_memory($1,$2)', [project, 'Practice plan']))[0].more_info, 'Updated details');
      assert.equal((await asUser(alice, 'select * from list_memories($1)', [project])).find(m => m.id === memory).description, 'Updated summary');
      await assert.rejects(asUser(alice, 'select * from correct_memory($1,1,$2,$3,$4)', [memory, 'Stale', 'Stale', 'Stale']), { code: 'PT409' });
    });
    await t.test('anonymous access is denied at both retrieval functions', async () => {
      for (const sql of [`select * from list_memories('${project}')`, `select * from read_memory('${project}', 'Practice plan')`]) {
        await db.exec('begin; set local role anon;');
        await assert.rejects(db.query(sql), { code: '42501' });
        await db.exec('rollback');
      }
    });
    await t.test('deleted memories vanish from both index and name lookup', async () => {
      assert.deepEqual(await asUser(alice, 'delete from memories where id=$1 and revision=1 returning id', [memory]), []);
      assert.equal((await asUser(alice, 'delete from memories where id=$1 and revision=2 returning id', [memory])).length, 1);
      assert.equal((await asUser(alice, 'select * from list_memories($1)', [project])).some(m => m.id === memory), false);
      await assert.rejects(asUser(alice, 'select * from read_memory($1,$2)', [project, 'Practice plan']), { code: 'P0002' });
    });
  } finally { await db.close(); }
});
