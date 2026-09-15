import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const project = '20000000-0000-4000-8000-000000000001';
const source = '40000000-0000-4000-8000-000000000001';
const otherSource = '40000000-0000-4000-8000-000000000002';
const otherProjectSource = '40000000-0000-4000-8000-0000000000aa';
const release = '50000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const commit = 'c'.repeat(40);
const sum = '1'.repeat(64);

let blobCounter = 0;
const skill = (name, description = '', blob) =>
  ({ name, path: `skills/${name}/SKILL.md`, description,
     blob_sha: blob ?? String(++blobCounter).padStart(40, '0') });

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
    await asUser(alice, 'select * from add_skill_source($1,$2)', [source, 'NeerajG03/my-skills']);
    await asUser(alice, 'select set_delivery_source($1)', [source]);

    await t.test('a source is normalized and its retry is not a conflict', async () => {
      const rows = await asUser(alice, 'select * from add_skill_source($1,$2)', [source, 'neerajg03/my-skills']);
      assert.equal(rows[0].repository, 'neerajg03/my-skills');
      assert.equal((await asUser(alice, 'select * from skill_sources')).length, 1);
    });

    await t.test('the same ID with a different payload is a conflict, never an overwrite', async () => {
      await assert.rejects(asUser(alice, 'select * from add_skill_source($1,$2)', [source, 'someone/else']), { code: '40001' });
    });

    await t.test('adding a repository already on the shelf returns it instead of failing', async () => {
      const rows = await asUser(alice, 'select * from add_skill_source($1,$2)',
        ['40000000-0000-4000-8000-0000000000ff', 'neerajg03/my-skills']);
      assert.equal(rows[0].id, source, 'the existing row wins, so connect never dead-ends on a duplicate');
      assert.equal((await asUser(alice, 'select * from skill_sources')).length, 1);
    });

    await t.test('the delivery target can be moved without getting stuck', async () => {
      await asUser(alice, 'select * from add_skill_source($1,$2)', [otherSource, 'vercel-labs/agent-skills']);
      await asUser(alice, 'select set_delivery_source($1)', [otherSource]);
      const rows = await asUser(alice, 'select id from skill_sources where is_delivery_target');
      assert.deepEqual(rows.map(r => r.id), [otherSource], 'the old holder is cleared in the same transaction');
      await asUser(alice, 'select set_delivery_source($1)', [source]);
      await assert.rejects(asUser(alice, 'select set_delivery_source($1)', [otherProjectSource]), { code: 'P0002' });
    });

    await t.test('syncing caches identity only, and there is no column for a body', async () => {
      const rows = await sync(alice, source, sha, [skill('review-style', 'How I want a review written.'), skill('trace-analysis')]);
      assert.deepEqual(rows.map(r => r.name), ['review-style', 'trace-analysis']);
      assert.equal(rows[0].seen_sha, sha);
      assert.match(rows[0].blob_sha, /^[0-9a-f]{40}$/);
      assert.notEqual(rows[0].blob_sha, rows[1].blob_sha,
        'a per-file identity, not the commit, or change detection is impossible');
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

    await t.test('list_skills exposes the per-file blob so a change is detectable', async () => {
      const [row] = await asUser(alice, 'select * from list_skills()');
      assert.match(row.blob_sha, /^[0-9a-f]{40}$/);
      const before = row.id;
      const edited = await sync(alice, source, nextSha, [skill('review-style', 'Back again.', 'f'.repeat(40))]);
      assert.equal(edited[0].blob_sha, 'f'.repeat(40));
      assert.equal(edited[0].id, before, 'an edit is not a new skill');
    });

    await t.test('another owner sees nothing and cannot reuse an ID or sync a foreign source', async () => {
      assert.deepEqual(await asUser(bob, 'select * from skill_sources'), []);
      assert.deepEqual(await asUser(bob, 'select * from skills'), []);
      assert.deepEqual(await asUser(bob, 'select * from list_skills()'), []);
      await assert.rejects(sync(bob, source, sha, [skill('stolen')]), { code: 'P0002' });
      await assert.rejects(asUser(bob, 'select * from add_skill_source($1,$2)', [source, 'bob/his-own']), { code: '40001' });
    });

    await t.test('an agent token is denied the shelf entirely', async () => {
      assert.deepEqual(await asUser(alice, 'select * from skill_sources', [], 'agent-client'), []);
      assert.deepEqual(await asUser(alice, 'select * from skills', [], 'agent-client'), []);
      await assert.rejects(sync(alice, source, sha, [skill('injected')], 'agent-client'), { code: 'P0002' });
    });

    let firstVersion;
    await t.test('versions increment per target and start again for the other one', async () => {
      const rows = await asUser(alice, 'select * from open_skill_release($1,$2,$3)',
        [release, 'claude-code', '{"skills":["review-style"]}']);
      firstVersion = rows[0].version;
      assert.equal(firstVersion, 1);
      assert.equal(rows[0].checksum, null, 'the tree cannot exist before the version does');
      assert.equal(rows[0].files, null);
      const second = await asUser(alice, 'select * from open_skill_release($1,$2,$3)',
        ['50000000-0000-4000-8000-000000000002', 'claude-code', '{}']);
      assert.equal(second[0].version, 2);
      const codex = await asUser(alice, 'select * from open_skill_release($1,$2,$3)',
        ['50000000-0000-4000-8000-000000000003', 'codex', '{}']);
      assert.equal(codex[0].version, 1);
    });

    await t.test('an uncertain publish is safe to retry, and a changed payload is not', async () => {
      assert.equal((await asUser(alice, 'select * from open_skill_release($1,$2,$3)',
        [release, 'claude-code', '{"skills":["review-style"]}']))[0].version, firstVersion);
      await assert.rejects(asUser(alice, 'select * from open_skill_release($1,$2,$3)',
        [release, 'codex', '{}']), { code: '40001' });
    });

    await t.test('a release is immutable apart from its delivery outcome', async () => {
      for (const column of ['manifest', 'version'])
        await assert.rejects(asUser(alice, `update skill_releases set ${column}=$1 where id=$2`, [column === 'version' ? 9 : '{}', release]), { code: '42501' });
      await assert.rejects(asUser(alice, 'update skill_releases set target=$1 where id=$2', ['codex', release]), { code: '42501' });
    });

    await t.test('delivery is stamped once and a second, different commit is a conflict', async () => {
      const files = '{"claude-code/skills/review-style/SKILL.md":"x"}';
      const paths = ['claude-code/skills/review-style/SKILL.md'];
      const rows = await asUser(alice, 'select * from finish_skill_release($1,$2,$3,$4,$5,$6)',
        [release, commit, files, sum, paths, null]);
      assert.equal(rows[0].commit_sha, commit);
      assert.equal(rows[0].checksum, sum, 'the checksum is stamped with the tree that was committed');
      assert.deepEqual(rows[0].generated_paths, paths);
      assert.ok(rows[0].delivered_at);
      await asUser(alice, 'select * from finish_skill_release($1,$2,$3,$4,$5,$6)', [release, commit, files, sum, paths, null]);
      await assert.rejects(asUser(alice, 'select * from finish_skill_release($1,$2,$3,$4,$5,$6)',
        [release, nextSha, files, sum, paths, null]), { code: 'PT409' });
    });

    await t.test('a malformed sha, checksum or skill list is refused', async () => {
      await assert.rejects(sync(alice, source, 'not-a-sha', [skill('review-style')]), { code: '23514' });
      await assert.rejects(asUser(alice, 'select * from open_skill_release($1,$2,$3)',
        ['50000000-0000-4000-8000-00000000000a', 'unsupported-host', '{}']), { code: '23514' });
      await assert.rejects(asUser(alice, 'select * from finish_skill_release($1,$2,$3,$4,$5,$6)',
        [release, commit, '{}', 'short', ['x'], null]), { code: '23514' });
      await assert.rejects(sync(alice, source, sha, [{ ...skill('bad-blob'), blob_sha: 'nope' }]), { code: '23514' });
      await assert.rejects(sync(alice, source, sha, { not: 'an array' }), { code: '23514' });
    });

    await t.test('delivery records a single claim per owner', async () => {
      await asUser(alice, 'select * from connect_skill_delivery($1,$2,$3)', ['NeerajG03/my-skills', 4242, 'main']);
      const rows = await asUser(alice, 'select * from connect_skill_delivery($1,$2,$3)', ['neerajg03/my-skills', 4343, 'master']);
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].installation_id), 4343);
      assert.equal(rows[0].repository, 'neerajg03/my-skills');
      assert.equal(rows[0].branch, 'master', 'the real default branch is recorded, not assumed');
      assert.equal((await asUser(alice, 'select * from skill_delivery')).length, 1);
      assert.deepEqual(await asUser(bob, 'select * from skill_delivery'), []);
    });
  } finally { await db.close(); }
});
