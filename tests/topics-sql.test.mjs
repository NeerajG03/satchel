// Topics at the database boundary: moving a memory keeps everything about it,
// a merge can be undone exactly, and an agent can only do either inside its
// grant. Tested against the real migration chain because the grant rules live
// in SQL and nowhere else.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

test('topics: move, make, merge and undo, each inside the grant', async t => {
  const db = new PGlite();
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  const infra = crypto.randomUUID(), infraTools = crypto.randomUUID(), work = crypto.randomUUID();
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
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    insert into auth.users values('${owner}'),('${other}');`);
  await applyMigrations(db);
  const user = {sub: owner};
  const claims = async client => (await db.query('select satchel_access_token_hook($1) result', [
    {user_id: owner, client_id: client, claims: {sub: owner, client_id: client, aud: 'authenticated'}}])).rows[0].result.claims;
  const grant = (client, all, ids, write) => call(user,
    'select authorize_agent_v3($1,$1,true,$2,$3,$4,true,$2,$3,$4,false)', [client, all, ids, write]);

  await call(user, 'select create_project($1,$2,$3)', [work, 'Work', 'the main project']);
  await grant('pass', true, [], true);
  await grant('narrow', false, [work], true);
  await grant('reader', true, [], false);
  const pass = await claims('pass'), narrow = await claims('narrow'), reader = await claims('reader');
  const save = async (project, statement) => (await call(user,
    'select * from save_memory($1,$2,$3,$4,$5)', [crypto.randomUUID(), project, statement, '', 'said']))[0];

  await t.test('the pass can make a topic, and it is marked as made by Satchel', async () => {
    await call(pass, 'select create_topic($1,$2,$3,$4,$5)', [crypto.randomUUID(), infra, 'infra', 'Infra', 'How infra is set up']);
    await call(pass, 'select create_topic($1,$2,$3,$4,$5)', [crypto.randomUUID(), infraTools, 'infra-tools', 'Infra Tools', 'Infra tooling']);
    const rows = await call(user, 'select slug, made_by from projects order by slug');
    assert.deepEqual(rows, [{slug: 'infra', made_by: 'satchel'}, {slug: 'infra-tools', made_by: 'satchel'},
      {slug: 'work', made_by: 'person'}]);
  });

  await t.test('moving a memory keeps its wording, band and count, and says where it was', async () => {
    const memory = await save(null, 'Grafana is gone, Oodle replaces it.');
    const [moved] = await call(pass, 'select * from move_memory($1,$2,$3,$4)', [memory.id, memory.revision, infra, 'a work fact']);
    assert.equal(moved.project_id, infra);
    assert.equal(moved.statement, memory.statement);
    assert.equal(moved.band, 'said');
    assert.equal(moved.mentions, memory.mentions);
    const [event] = await call(user, "select action, before, after, reason from memory_events where memory_id=$1 and action='moved'", [memory.id]);
    assert.deepEqual(event, {action: 'moved', before: 'personal', after: 'infra', reason: 'a work fact'});
  });

  await t.test('a stale revision, a read-only grant or a scope outside the grant is refused', async () => {
    const memory = await save(null, 'Base images come from infra-images.');
    await assert.rejects(call(pass, 'select move_memory($1,$2,$3)', [memory.id, memory.revision + 5, infra]), {code: 'PT409'});
    await assert.rejects(call(reader, 'select move_memory($1,$2,$3)', [memory.id, memory.revision, infra]), {code: '42501'});
    await assert.rejects(call(narrow, 'select move_memory($1,$2,$3)', [memory.id, memory.revision, infra]), {code: '42501'});
    await assert.rejects(call({sub: other}, 'select move_memory($1,$2,$3)', [memory.id, memory.revision, infra]), {code: 'PT409'});
  });

  await t.test('a merge moves the live memories, hides the topic, and the undo moves back only those', async () => {
    const first = await save(infraTools, 'Deploys go through infra-configurations.');
    const [merge] = await call(pass, 'select * from merge_topic($1,$2,$3)', [infraTools, infra, 'same subject']);
    assert.deepEqual(merge.memory_ids, [first.id]);
    assert.equal((await call(user, 'select merged_into from projects where id=$1', [infraTools]))[0].merged_into, infra);
    assert.equal((await call(user, 'select project_id from memories where id=$1', [first.id]))[0].project_id, infra);
    const later = await save(infra, 'Infra tickets go straight to Done.');
    await assert.rejects(call(pass, 'select move_memory($1,$2,$3)', [later.id, later.revision, infraTools]), {code: '23514'});
    const [undone] = await call(user, 'select * from unmerge_topic($1)', [infraTools]);
    assert.ok(undone.undone_at);
    assert.equal((await call(user, 'select project_id from memories where id=$1', [first.id]))[0].project_id, infraTools);
    assert.equal((await call(user, 'select project_id from memories where id=$1', [later.id]))[0].project_id, infra);
    assert.equal((await call(user, 'select merged_into from projects where id=$1', [infraTools]))[0].merged_into, null);
  });

  await t.test('a topic with tasks or a repository is never merged', async () => {
    await call(user, 'select link_project_repository($1,$2,$3)', [work, 'github', 'acme/work']);
    await assert.rejects(call(pass, 'select merge_topic($1,$2)', [work, infra]), {code: '23514'});
  });

  await t.test('an app merges only topics Satchel made; the person may merge their own', async () => {
    const mine = crypto.randomUUID();
    await call(user, 'select create_project($1,$2,$3)', [mine, 'Mine', 'a topic I made']);
    await assert.rejects(call(pass, 'select merge_topic($1,$2)', [mine, infra]), {code: '23514'});
    const [merge] = await call(user, 'select * from merge_topic($1,$2)', [mine, infra]);
    assert.equal(merge.from_id, mine);
  });

  await t.test('merges are readable by their owner only, and not writable directly', async () => {
    assert.ok((await call(user, 'select * from topic_merges')).length >= 1);
    assert.deepEqual(await call({sub: other}, 'select * from topic_merges'), []);
    await assert.rejects(call(user, 'delete from topic_merges'), {code: '42501'});
  });
});
