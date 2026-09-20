import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, migrationFiles } from './helpers/migrations.mjs';

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
  const save = (owner, id, scope, name, statement, details = '') =>
    asUser(owner, 'select * from save_memory($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, scope, statement, '', 'said', null, name, details]);
  // v2 reads by id, because a name is now an optional handle rather than the
  // record's key. Scope still has to be supplied and is still enforced.
  const read = (owner, scope, id, clientId) =>
    asUser(owner, 'select * from read_memory($1,$2)', [scope, id], clientId);
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
    const files = await migrationFiles();
    const personalMigration = files.indexOf('202609110002_personal_memory.sql');
    await applyMigrations(db, { files: files.slice(0, personalMigration) });
    await asUser(alice, 'select * from create_project($1,$2,$3)', [project, 'Existing project', 'Keep existing data']);
    // Saved against the pre-v2 signature on purpose: this row is the evidence
    // that the shape migration carries existing data across untouched.
    const [before] = await asUser(alice, 'select * from save_memory($1,$2,$3,$4,$5)',
      [projectMemory, project, 'preferences', 'Project description', 'Project-only details']);
    await applyMigrations(db, { files: files.slice(personalMigration) });

    await t.test('migration preserves every existing project field and revision', async () => {
      const [after] = await read(alice, project, projectMemory);
      // v2 adds columns and renames description to statement, so the comparison
      // covers every field that survived under its own name. Nothing else about
      // an existing row may move, and revision in particular must not, or every
      // client holding one sees a spurious conflict on its next write.
      for (const field of Object.keys(before)) {
        if (field === 'description') continue;
        assert.deepEqual(after[field], before[field], field);
      }
      assert.equal(after.statement, before.description, 'the description carries over verbatim');
      assert.equal(after.source, before.description, 'and is kept as its own provenance');
      assert.equal(after.revision, 1, 'the backfill must not bump revisions');
      assert.equal(after.band, 'said', 'an explicitly saved memory stays confirmed');
      assert.deepEqual(await asUser(alice, 'select * from list_memories(null)'), []);
    });
    await t.test('a user with zero projects can save, retry and read personal memory', async () => {
      assert.deepEqual(await asUser(bob, 'select * from projects'), []);
      const args = [bob, personalMemory, null, 'preferences', 'Personal description', 'Personal-only details'];
      const [saved] = await save(...args);
      const [retried] = await save(...args);
      assert.equal(saved.id, retried.id); assert.equal(retried.revision, 1);
      assert.equal(saved.project_id, null);
      const [row] = await read(bob, null, personalMemory);
      assert.equal(row.more_info, 'Personal-only details');
      const [summary] = await asUser(bob, 'select * from list_memories(null)');
      assert.equal(summary.id, personalMemory);
      assert.equal('more_info' in summary, false, 'the index carries a flag, never the detail');
      assert.equal(summary.has_more_info, true);
      assert.equal(summary.statement, 'Personal description');
      assert.deepEqual(await asUser(bob, 'select * from projects'), []);
    });
    await t.test('same name works across personal/project scopes and different owners', async () => {
      const [personal] = await save(alice, crypto.randomUUID(), null, 'preferences', 'Alice personal', 'Alice-only personal details');
      const [personalRead] = await read(alice, null, personal.id);
      const [projectRead] = await read(alice, project, projectMemory);
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
      await assert.rejects(read(alice, null, personalMemory), { code: 'P0002' });
      assert.deepEqual(await asUser(bob, 'select * from list_memories(null)', [], 'unapproved-agent'), []);
      await assert.rejects(read(bob, null, personalMemory, 'unapproved-agent'), { code: 'P0002' });
      await assert.rejects(asUser(bob, 'select * from save_memory($1,null,$2)', [crypto.randomUUID(), 'Denied'], 'unapproved-agent'), { code: '42501' });
    });
    await t.test('personal correction and rename enforce expected revisions', async () => {
      const [row] = await asUser(bob, 'select * from correct_memory($1,1,$2,$3,$4)',
        [personalMemory, 'Updated personal description', 'writing-preferences', 'Updated personal details']);
      assert.equal(row.revision, 2); assert.equal(row.project_id, null);
      assert.equal(row.name, 'writing-preferences');
      await assert.rejects(asUser(bob, 'select * from correct_memory($1,1,$2,$3,$4)',
        [personalMemory, 'stale', 'stale', 'stale']), { code: 'PT409' });
      assert.equal((await read(bob, null, personalMemory))[0].more_info, 'Updated personal details');
    });
    await t.test('deleting personal memory checks revisions without affecting project memory', async () => {
      assert.deepEqual(await asUser(bob, 'delete from memories where id=$1 and revision=1 returning id', [personalMemory]), []);
      assert.equal((await asUser(bob, 'delete from memories where id=$1 and revision=2 returning id', [personalMemory])).length, 1);
      assert.deepEqual(await asUser(bob, 'select * from list_memories(null)'), []);
      assert.equal((await read(alice, project, projectMemory))[0].more_info, 'Project-only details');
    });
    await t.test('anonymous access cannot list personal summaries', async () => {
      await db.exec('begin; set local role anon;');
      await assert.rejects(db.query('select * from list_memories(null)'), { code: '42501' });
      await db.exec('rollback');
    });
  } finally { await db.close(); }
});
