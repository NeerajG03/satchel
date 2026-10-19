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

  const task = crypto.randomUUID(), blocker = crypto.randomUUID();
  const create = (id, title) => call(user, 'select * from create_task($1,$2,null,$3)', [crypto.randomUUID(), id, title]);
  const edit = (revision, title, add) => call(user, `select * from save_task_edit(p_request_id=>$1,p_id=>$2,p_expected_revision=>$3,
    p_title=>$4,p_outcome=>'',p_why=>'',p_done_when=>'{}',p_next_action=>'',p_priority=>'medium',p_add_dependency_ids=>$5)`,
    [crypto.randomUUID(), task, revision, title, add]);

  await t.test('a refused dependency takes the field changes back with it', async () => {
    await create(task, 'Write the release notes');
    await create(blocker, 'Cut the release');
    await assert.rejects(edit(1, 'Renamed', [crypto.randomUUID()]), /Task unavailable|not found|unavailable/i);
    const [row] = await call(user, 'select title, revision from tasks where id=$1', [task]);
    assert.equal(row.title, 'Write the release notes');
    assert.equal(Number(row.revision), 1);
  });

  await t.test('fields and a new dependency save together, as one revision chain', async () => {
    const [saved] = await edit(1, 'Renamed', [blocker]);
    assert.equal(saved.title, 'Renamed');
    assert.ok(Number(saved.revision) > 1);
    const [planned] = await call(user, 'select dependency_ids from task_planning where id=$1', [task]);
    assert.deepEqual(planned.dependency_ids, [blocker]);
  });

  await t.test('a retry with the same request id returns the saved task instead of a conflict', async () => {
    const second = crypto.randomUUID(), third = crypto.randomUUID();
    await create(second, 'Draft the post');
    await create(third, 'Pick a date');
    for (const [label, title, add] of [['fields and a dependency', 'Draft the launch post', [third]], ['a dependency alone', null, []]]) {
      const [{revision}] = await call(user, 'select revision from tasks where id=$1', [second]);
      const requestId = crypto.randomUUID();
      const args = title ? [requestId, second, revision, title, add, []] : [requestId, second, revision, null, [], [third]];
      const run = () => call(user, `select * from save_task_edit(p_request_id=>$1,p_id=>$2,p_expected_revision=>$3,
        p_title=>$4,p_outcome=>'',p_why=>'',p_done_when=>'{}',p_next_action=>'',p_priority=>'medium',
        p_add_dependency_ids=>$5,p_remove_dependency_ids=>$6)`, args);
      const [first] = await run();
      const [again] = await run();
      assert.equal(Number(again.revision), Number(first.revision), label);
    }
    const [{revision}] = await call(user, 'select revision from tasks where id=$1', [second]);
    const reused = crypto.randomUUID();
    const save = title => call(user, `select save_task_edit($1,$2,$3,$4,'','','{}','','medium')`, [reused, second, revision, title]);
    await save('Draft the launch post, again');
    await assert.rejects(save('Something else entirely'), {code: 'PT409'});
    const [{revision: now}] = await call(user, 'select revision from tasks where id=$1', [second]);
    const both = add => call(user, `select save_task_edit(p_request_id=>$1,p_id=>$2,p_expected_revision=>$3,p_title=>'Same title',
      p_outcome=>'',p_why=>'',p_done_when=>'{}',p_next_action=>'',p_priority=>'medium',p_add_dependency_ids=>$4)`, [reused, second, now, add]);
    await both([]);
    await assert.rejects(both([task]), {code: 'PT409'}, 'the same first step with a different rest is a different edit');
  });

  await t.test('a stale revision changes nothing', async () => {
    await assert.rejects(edit(1, 'Stale', []), /conflict|changed/i);
    assert.equal((await call(user, 'select title from tasks where id=$1', [task]))[0].title, 'Renamed');
  });

  await t.test('another person cannot edit my task through it', async () => {
    const [{revision}] = await call(user, 'select revision from tasks where id=$1', [task]);
    await assert.rejects(call({sub: other}, `select save_task_edit($1,$2,$3,'Theirs')`, [crypto.randomUUID(), task, revision]));
    assert.equal((await call(user, 'select title from tasks where id=$1', [task]))[0].title, 'Renamed');
  });

  await t.test('anonymous cannot call either routine', async () => {
    await db.exec('begin; set local role anon;');
    await assert.rejects(db.query('select save_task_edit($1,$2,1)', [crypto.randomUUID(), task]), /permission denied/);
    await db.exec('rollback');
    await db.exec('begin; set local role anon;');
    await assert.rejects(db.query("select create_topic($1,'x','','x')", [crypto.randomUUID()]), /permission denied/);
    await db.exec('rollback');
  });
});
