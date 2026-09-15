import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const project = '20000000-0000-4000-8000-000000000001';
const source = '40000000-0000-4000-8000-000000000001';
const otherSource = '40000000-0000-4000-8000-000000000002';
const release = '50000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const commit = 'c'.repeat(40);
const sum = '1'.repeat(64);

const skill = (name, description = '') =>
  ({ name, path: `skills/${name}/SKILL.md`, description });

test('the skills shelf stores no content, isolates owners and keeps releases immutable', async t => {
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
  const sync = (owner, src, at, skills, clientId) =>
    asUser(owner, 'select * from sync_skill_source($1,$2,$3)', [src, at, JSON.stringify(skills)], clientId);

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
    const dir = new URL('../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort())
      await db.exec(await readFile(new URL(file, dir), 'utf8'));

    await asUser(alice, 'select * from create_project($1,$2,$3)', [project, 'Satchel', '']);
    await asUser(alice, 'select * from add_skill_source($1,$2,$3)', [source, 'NeerajG03/my-skills', true]);

    await t.test('a source is normalized and its retry is not a conflict', async () => {
      const rows = await asUser(alice, 'select * from add_skill_source($1,$2,$3)', [source, 'neerajg03/my-skills', true]);
      assert.equal(rows[0].repository, 'neerajg03/my-skills');
      assert.equal((await asUser(alice, 'select * from skill_sources')).length, 1);
    });

    await t.test('the same ID with a different payload is a conflict, never an overwrite', async () => {
      await assert.rejects(asUser(alice, 'select * from add_skill_source($1,$2,$3)', [source, 'someone/else', true]), { code: '40001' });
    });

    await t.test('only one repository may be the delivery target', async () => {
      await assert.rejects(asUser(alice, 'select * from add_skill_source($1,$2,$3)', [otherSource, 'neerajg03/other', true]), { code: '23505' });
      await asUser(alice, 'select * from add_skill_source($1,$2,$3)', [otherSource, 'vercel-labs/agent-skills', false]);
    });

    await t.test('syncing caches identity only, and there is no column for a body', async () => {
      const rows = await sync(alice, source, sha, [skill('review-style', 'How I want a review written.'), skill('trace-analysis')]);
      assert.deepEqual(rows.map(r => r.name), ['review-style', 'trace-analysis']);
      assert.equal(rows[0].seen_sha, sha);
      const columns = await asUser(alice, `select column_name from information_schema.columns
        where table_schema='public' and table_name='skills'`);
      const names = columns.map(c => c.column_name);
      for (const forbidden of ['body', 'more_info', 'content'])
        assert.ok(!names.includes(forbidden), `skills must not store ${forbidden}`);
    });

    await t.test('a name that cannot be a skill directory is refused', async () => {
      for (const bad of ['Review Style', 'review_style', '-leading', 'trailing-'])
        await assert.rejects(sync(alice, source, sha, [skill(bad)]), { code: '23514' });
    });

    let reviewId;
    await t.test('a re-sync keeps IDs stable so a kit selection survives it', async () => {
      reviewId = (await asUser(alice, `select id from skills where name='review-style'`))[0].id;
      await asUser(alice, 'select set_kit_item($1,$2,$3)', ['claude-code', reviewId, true]);
      await asUser(alice, 'select set_kit_item($1,$2,$3)', ['claude-code', reviewId, true]);
      const rows = await sync(alice, source, nextSha, [skill('review-style', 'Edited upstream.'), skill('trace-analysis')]);
      assert.equal(rows.find(r => r.name === 'review-style').id, reviewId);
      assert.equal(rows.find(r => r.name === 'review-style').description, 'Edited upstream.');
      const kit = await asUser(alice, 'select * from skill_kit_items');
      assert.equal(kit.length, 1);
      assert.equal(kit[0].skill_id, reviewId);
    });

    await t.test('a skill removed upstream leaves the shelf and the kit', async () => {
      await sync(alice, source, nextSha, [skill('review-style', 'Edited upstream.')]);
      assert.deepEqual((await asUser(alice, 'select name from skills order by name')).map(r => r.name), ['review-style']);
      await asUser(alice, 'select set_kit_item($1,$2,$3)', ['codex', reviewId, true]);
      await sync(alice, source, nextSha, []);
      assert.deepEqual(await asUser(alice, 'select * from skill_kit_items'), []);
      await sync(alice, source, nextSha, [skill('review-style', 'Back again.')]);
    });

    await t.test('list_skills reports a source that moved past what we read', async () => {
      const [row] = await asUser(alice, 'select * from list_skills()');
      assert.equal(row.changed, false);
      await asUser(alice, 'update skill_sources set commit_sha=$1 where id=$2', [commit, source]);
      assert.equal((await asUser(alice, 'select * from list_skills()'))[0].changed, true);
    });

    await t.test('another owner sees nothing and cannot reuse an ID or sync a foreign source', async () => {
      assert.deepEqual(await asUser(bob, 'select * from skill_sources'), []);
      assert.deepEqual(await asUser(bob, 'select * from skills'), []);
      assert.deepEqual(await asUser(bob, 'select * from list_skills()'), []);
      await assert.rejects(sync(bob, source, sha, [skill('stolen')]), { code: 'P0002' });
      await assert.rejects(asUser(bob, 'select * from add_skill_source($1,$2,$3)', [source, 'bob/his-own', false]), { code: '40001' });
    });

    await t.test('an agent token is denied the shelf entirely', async () => {
      assert.deepEqual(await asUser(alice, 'select * from skill_sources', [], 'agent-client'), []);
      assert.deepEqual(await asUser(alice, 'select * from skills', [], 'agent-client'), []);
      await assert.rejects(sync(alice, source, sha, [skill('injected')], 'agent-client'), { code: 'P0002' });
    });

    let firstVersion;
    await t.test('versions increment per target and start again for the other one', async () => {
      const args = [release, 'claude-code', '{"skills":["review-style"]}', '{"claude-code/skills/review-style/SKILL.md":"x"}', ['claude-code/skills/review-style/SKILL.md'], sum];
      const rows = await asUser(alice, 'select * from open_skill_release($1,$2,$3,$4,$5,$6)', args);
      firstVersion = rows[0].version;
      assert.equal(firstVersion, 1);
      const second = await asUser(alice, 'select * from open_skill_release($1,$2,$3,$4,$5,$6)',
        ['50000000-0000-4000-8000-000000000002', 'claude-code', '{}', '{}', ['claude-code/x'], sum]);
      assert.equal(second[0].version, 2);
      const codex = await asUser(alice, 'select * from open_skill_release($1,$2,$3,$4,$5,$6)',
        ['50000000-0000-4000-8000-000000000003', 'codex', '{}', '{}', ['codex/x'], sum]);
      assert.equal(codex[0].version, 1);
    });

    await t.test('an uncertain publish is safe to retry, and a changed payload is not', async () => {
      const args = [release, 'claude-code', '{"skills":["review-style"]}', '{"claude-code/skills/review-style/SKILL.md":"x"}', ['claude-code/skills/review-style/SKILL.md'], sum];
      assert.equal((await asUser(alice, 'select * from open_skill_release($1,$2,$3,$4,$5,$6)', args))[0].version, firstVersion);
      await assert.rejects(asUser(alice, 'select * from open_skill_release($1,$2,$3,$4,$5,$6)',
        [release, 'claude-code', '{}', '{}', ['other'], '2'.repeat(64)]), { code: '40001' });
    });

    await t.test('a release is immutable apart from its delivery outcome', async () => {
      for (const column of ['manifest', 'files', 'checksum', 'version'])
        await assert.rejects(asUser(alice, `update skill_releases set ${column}=$1 where id=$2`, [column === 'version' ? 9 : '{}', release]), { code: '42501' });
      await assert.rejects(asUser(alice, 'update skill_releases set generated_paths=$1 where id=$2', [['tampered'], release]), { code: '42501' });
    });

    await t.test('delivery is stamped once and a second, different commit is a conflict', async () => {
      const rows = await asUser(alice, 'select * from finish_skill_release($1,$2,$3)', [release, commit, null]);
      assert.equal(rows[0].commit_sha, commit);
      assert.ok(rows[0].delivered_at);
      await asUser(alice, 'select * from finish_skill_release($1,$2,$3)', [release, commit, null]);
      await assert.rejects(asUser(alice, 'select * from finish_skill_release($1,$2,$3)', [release, nextSha, null]), { code: 'PT409' });
    });

    await t.test('a malformed sha, checksum or skill list is refused', async () => {
      await assert.rejects(sync(alice, source, 'not-a-sha', [skill('review-style')]), { code: '23514' });
      await assert.rejects(asUser(alice, 'select * from open_skill_release($1,$2,$3,$4,$5,$6)',
        ['50000000-0000-4000-8000-000000000009', 'claude-code', '{}', '{}', ['x'], 'short']), { code: '23514' });
      await assert.rejects(asUser(alice, 'select * from open_skill_release($1,$2,$3,$4,$5,$6)',
        ['50000000-0000-4000-8000-00000000000a', 'unsupported-host', '{}', '{}', ['x'], sum]), { code: '23514' });
      await assert.rejects(sync(alice, source, sha, { not: 'an array' }), { code: '23514' });
    });

    await t.test('delivery records a single claim per owner', async () => {
      await asUser(alice, 'select * from connect_skill_delivery($1,$2)', ['NeerajG03/my-skills', 4242]);
      const rows = await asUser(alice, 'select * from connect_skill_delivery($1,$2)', ['neerajg03/my-skills', 4343]);
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].installation_id), 4343);
      assert.equal(rows[0].repository, 'neerajg03/my-skills');
      assert.equal((await asUser(alice, 'select * from skill_delivery')).length, 1);
      assert.deepEqual(await asUser(bob, 'select * from skill_delivery'), []);
    });
  } finally { await db.close(); }
});
