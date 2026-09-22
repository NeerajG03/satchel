// A memory can go stale because something merged.
//
// Every system we looked at detects contradiction from conversation, which
// assumes the world changes when the user mentions it. Both stale rows in
// Satchel's own production data were made false by a migration and a commit,
// and nothing anyone said contradicted either of them. They were also the only
// project-scoped memories with embeddings, so a hundred percent of retrievable
// project memory was wrong and no amount of listening would have caught it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

async function database() {
  const db = new PGlite();
  const owner = crypto.randomUUID();
  await db.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth; create schema storage;
    create table storage.objects(bucket_id text,name text,metadata jsonb,user_metadata jsonb);
    create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as
      $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    insert into auth.users values('${owner}');
  `);
  await applyMigrations(db);
  async function call(sql, params = []) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub: owner})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  return {db, owner, call};
}

test('a memory is anchored to where the repository was when it was last meant', async t => {
  const {db, call} = await database();
  const project = crypto.randomUUID();
  const scoped = crypto.randomUUID(), personal = crypto.randomUUID();
  const head = commits => call('select record_repository_head($1,$2,$3)', ['github', 'acme/ledger', commits]);
  const anchorOf = id => call('select anchor_repository, anchor_commits from memories where id=$1', [id])
    .then(rows => rows[0]);
  const sinceOf = async id => (await call('select * from memories_in_scope($1)', [project]))
    .find(row => row.id === id)?.commits_since;
  try {
    await call('select * from create_project($1,$2,$3)', [project, 'Ledger', '']);
    await call('select * from link_project_repository($1,$2,$3)', [project, 'github', 'acme/ledger']);

    await t.test('without an observation there is nothing to anchor to', async () => {
      const early = crypto.randomUUID();
      await call('select * from save_memory($1,$2,$3)', [early, project, 'Written before anyone counted.']);
      assert.deepEqual(await anchorOf(early), {anchor_repository: null, anchor_commits: null});
      assert.equal(await sinceOf(early), null, 'and no doubt can be raised about it');
    });

    await head(1000);

    await t.test('a project memory takes the count at the moment it is written', async () => {
      await call('select * from save_memory($1,$2,$3)', [scoped, project, 'The hook reads the transcript.']);
      assert.deepEqual(await anchorOf(scoped), {anchor_repository: 'acme/ledger', anchor_commits: 1000});
    });

    await t.test('a personal memory never anchors, because a merge cannot falsify a preference', async () => {
      await call('select * from save_memory($1,$2,$3)', [personal, null, 'No em dashes.']);
      assert.deepEqual(await anchorOf(personal), {anchor_repository: null, anchor_commits: null});
    });

    await t.test('the repository moving is measured, not guessed', async () => {
      await head(1120);
      assert.equal(await sinceOf(scoped), 120);
      assert.equal((await call('select * from memories_in_scope($1)', [project]))
        .find(row => row.id === personal).commits_since, null);
    });

    await t.test('saying it again resets the doubt', async () => {
      await call('select * from affirm_memory($1)', [scoped]);
      assert.deepEqual(await anchorOf(scoped), {anchor_repository: 'acme/ledger', anchor_commits: 1120});
      assert.equal(await sinceOf(scoped), 0);
    });

    await t.test('so does correcting it, which was the gap', async () => {
      // Correcting means "this is right, now". It did not move affirmed_at,
      // which left a corrected memory carrying the doubt of the version it
      // replaced, permanently.
      await head(1200);
      const [{revision}] = await call('select revision from memories where id=$1', [scoped]);
      await call('select * from correct_memory($1,$2,$3)', [scoped, revision, 'The hook does not read the transcript.']);
      assert.equal(await sinceOf(scoped), 0);
    });

    await t.test('embedding it does not', async () => {
      await head(1300);
      await call(`update memories set embedding = array_fill(0.1::real, array[768]),
        embedding_model = 'test', embedded_at = now() where id=$1`, [scoped]);
      assert.equal(await sinceOf(scoped), 100, 'bookkeeping must not look like agreement');
    });

    await t.test('a count that goes backwards is ignored', async () => {
      // A stale hook, a shallow clone or a checked-out older branch would
      // otherwise make every memory look freshly confirmed.
      await head(50);
      const [row] = await call('select commits from repository_heads');
      assert.equal(row.commits, 1300);
    });
  } finally { await db.close(); }
});

test('nobody sees another owner’s repository counts', async () => {
  const {db, call} = await database();
  const other = crypto.randomUUID();
  try {
    await db.exec(`insert into auth.users values('${other}')`);
    await call('select record_repository_head($1,$2,$3)', ['github', 'acme/ledger', 900]);
    await db.exec('begin; set local role authenticated;');
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub: other})]);
    const rows = (await db.query('select * from repository_heads')).rows;
    await db.exec('commit');
    assert.deepEqual(rows, []);
  } finally { await db.close(); }
});
