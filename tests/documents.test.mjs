// The document store, against a real database.
//
// Documents are the thing capture never had: a durable record that outlives
// the turn it was said in. Everything here is about the two properties that
// make re-derivation possible at all, because both are easy to lose quietly.
// The record has to survive the session that produced it, and it has to stay
// the owner's alone.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

async function database() {
  const db = new PGlite();
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
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
    insert into auth.users values('${owner}'),('${other}');
  `);
  await applyMigrations(db);
  async function call(sub, sql, params = []) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  return {db, owner, other, call};
}

const say = (call, sub, role, content, project = null) =>
  call(sub, 'select record_turn($1,$2,$3,$4,$5) id', ['s1', role, content, 10, project]);
const documentOf = async (call, sub) =>
  (await call(sub, 'select * from session_document($1)', ['s1']))[0] ?? null;

test('a session becomes one document that outlives its rolling window', async t => {
  const {db, owner, other, call} = await database();
  try {
    await say(call, owner, 'user', 'never bump the Go version until payouts ship');
    await say(call, owner, 'assistant', 'Noted. I will leave go.mod alone.');
    await say(call, owner, 'user', 'and no em dashes anywhere');

    await t.test('both halves are kept, in the order they were said', async () => {
      const doc = await documentOf(call, owner);
      assert.equal(doc.turns, 3);
      const turns = await call(owner, 'select * from document_content($1)', [doc.id]);
      assert.deepEqual(turns.map(t => [t.role, t.content]), [
        ['user', 'never bump the Go version until payouts ship'],
        ['assistant', 'Noted. I will leave go.mod alone.'],
        ['user', 'and no em dashes anywhere'],
      ]);
    });

    await t.test('the rolling window can be emptied and the document stays', async () => {
      // This is the whole point of the split. session_messages is trimmed as
      // it goes and deleted after 24 hours; if the document went with it there
      // would be nothing to re-derive from.
      await call(owner, 'select clear_session_window($1)', ['s1']);
      assert.deepEqual(await call(owner, 'select * from session_window($1,$2)', ['s1', 10]), []);
      assert.equal((await documentOf(call, owner)).turns, 3);
    });

    await t.test('a later pass reads only what it has not seen', async () => {
      const doc = await documentOf(call, owner);
      const all = await call(owner, 'select * from document_content($1)', [doc.id]);
      const after = await call(owner, 'select * from document_content($1,$2)', [doc.id, all[0].id]);
      assert.equal(after.length, 2);
      assert.equal(after[0].content, 'Noted. I will leave go.mod alone.');
    });

    await t.test('nobody else can read it, by document id or by session key', async () => {
      const doc = await documentOf(call, owner);
      assert.equal(await documentOf(call, other), null);
      assert.deepEqual(await call(other, 'select * from document_content($1)', [doc.id]), []);
      // Same session key, different owner: a separate document, not a shared one.
      await say(call, other, 'user', 'something else entirely');
      assert.notEqual((await documentOf(call, other)).id, doc.id);
      assert.equal((await documentOf(call, other)).turns, 1);
    });
  } finally { await db.close(); }
});

test('a document carries one scope, and only a scope its owner holds', async t => {
  const {db, owner, other, call} = await database();
  const mine = crypto.randomUUID(), theirs = crypto.randomUUID();
  try {
    await call(owner, 'select * from create_project($1,$2,$3)', [mine, 'Satchel', '']);
    await call(other, 'select * from create_project($1,$2,$3)', [theirs, 'Theirs', '']);

    await t.test('an unscoped turn leaves the document personal', async () => {
      await say(call, owner, 'user', 'what did we decide');
      assert.equal((await documentOf(call, owner)).project_id, null);
    });

    await t.test('the first turn that knows the scope sets it', async () => {
      await say(call, owner, 'assistant', 'We decided nothing yet.', mine);
      assert.equal((await documentOf(call, owner)).project_id, mine);
    });

    await t.test('a later turn without a scope does not clear it', async () => {
      await say(call, owner, 'user', 'right, carry on');
      assert.equal((await documentOf(call, owner)).project_id, mine);
    });

    await t.test('a project the caller does not own is dropped, not borrowed', async () => {
      // Silently personal rather than an error: the turn is the thing worth
      // keeping, and a document scoped into someone else's project would be a
      // leak rather than a mistake.
      await say(call, other, 'user', 'my own session', mine);
      assert.equal((await documentOf(call, other)).project_id, null);
    });

    await t.test('deleting the project keeps the conversation', async () => {
      const [{revision}] = await call(owner, 'select revision from projects where id=$1', [mine]);
      await call(owner, 'select delete_project($1,$2)', [mine, revision]);
      const doc = await documentOf(call, owner);
      assert.equal(doc.project_id, null);
      assert.equal(doc.turns, 3);
    });
  } finally { await db.close(); }
});

test('the end of a turn notes the scope even when the host gives no reply', async () => {
  // Codex has no last_assistant_message, so its Stop hook has nothing to
  // append. It is still the moment the repository has been resolved, and a
  // document with no scope is a document consolidation cannot place.
  const {db, owner, call} = await database();
  const project = crypto.randomUUID();
  try {
    await call(owner, 'select * from create_project($1,$2,$3)', [project, 'Satchel', '']);
    await say(call, owner, 'user', 'keep the client on 4.1');
    await say(call, owner, 'assistant', '', project);
    const doc = await documentOf(call, owner);
    assert.equal(doc.turns, 1, 'an empty reply is not a turn');
    assert.equal(doc.project_id, project, 'but it is still a scope');
  } finally { await db.close(); }
});

test('retention is a deletion, not a policy sentence', async t => {
  const {db, owner, call} = await database();
  try {
    await say(call, owner, 'user', 'this expires in thirty days');
    const doc = await documentOf(call, owner);

    await t.test('a fresh document is thirty days from being deleted', async () => {
      const [{days}] = await call(owner,
        'select round(extract(epoch from $1::timestamptz - now()) / 86400) days', [doc.expires_at]);
      assert.equal(Number(days), 30);
    });

    await t.test('past its expiry the conversation is gone, turns and all', async () => {
      await db.exec(`update public.documents set expires_at = now() - interval '1 second'`);
      const [{expire_documents: removed}] = await call(owner, 'select expire_documents()');
      assert.equal(removed, 1);
      assert.equal(await documentOf(call, owner), null);
      const [{count}] = (await db.query('select count(*)::int from public.document_turns')).rows;
      assert.equal(count, 0, 'the turns go with it');
    });

    await t.test('recording a turn expires whatever is due', async () => {
      await say(call, owner, 'user', 'a new session entirely');
      await db.exec(`update public.documents set expires_at = now() - interval '1 second'`);
      await call(owner, 'select record_turn($1,$2,$3,$4,$5)', ['s2', 'user', 'unrelated', 10, null]);
      assert.equal(await documentOf(call, owner), null);
    });
  } finally { await db.close(); }
});

test('asked for no count, every waiting session comes back', async () => {
  // The pass used to ask for ten, and the default was twenty. Neither was a
  // measure of anything, and on 22 September the cap left the three newest
  // sessions unread with time to spare.
  const {db, owner, call} = await database();
  try {
    for (let i = 0; i < 25; i++)
      await call(owner, 'select record_turn($1,$2,$3,$4,$5)', [`s${i}`, 'user', `session ${i}`, 10, null]);
    await db.exec(`update public.documents set last_turn_at = now() - interval '2 hours'`);
    assert.equal((await call(owner, 'select * from pending_documents($1)', [30])).length, 25);
    assert.equal((await call(owner, 'select * from pending_documents($1,$2)', [30, 5])).length, 5,
      'a caller that does name a count still gets it');
  } finally { await db.close(); }
});

test('a document stops growing rather than growing without a limit', async () => {
  const {db, owner, call} = await database();
  try {
    const filler = 'x'.repeat(8000);
    for (let i = 0; i < 50; i++) await say(call, owner, 'user', filler);
    let doc = await documentOf(call, owner);
    assert.equal(doc.chars, 400000);
    assert.equal(doc.truncated_at, null);
    await say(call, owner, 'user', 'one more thing');
    doc = await documentOf(call, owner);
    assert.equal(doc.turns, 50, 'the turn is refused');
    assert.notEqual(doc.truncated_at, null, 'and the document says so');
  } finally { await db.close(); }
});

test('consolidation picks up sessions that are finished, once each', async t => {
  const {db, owner, other, call} = await database();
  const pending = (sub, idle = 30) =>
    call(sub, 'select * from pending_documents($1,$2)', [idle, 20]);
  try {
    await say(call, owner, 'user', 'still typing');

    await t.test('a session still being typed into is not ready', async () => {
      assert.deepEqual(await pending(owner), []);
    });

    await t.test('an idle session with unread turns is', async () => {
      await db.exec(`update public.documents set last_turn_at = now() - interval '2 hours'`);
      const rows = await pending(owner);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].session_key, 's1');
    });

    await t.test('nobody sees anyone else’s', async () => {
      assert.deepEqual(await pending(other), []);
    });

    await t.test('once read it stops coming back', async () => {
      const doc = await documentOf(call, owner);
      const turns = await call(owner, 'select * from document_content($1)', [doc.id]);
      await call(owner, 'select mark_document_consolidated($1,$2)',
        [doc.id, turns[turns.length - 1].id]);
      assert.deepEqual(await pending(owner), []);
    });

    await t.test('a session that carries on is pending again', async () => {
      await say(call, owner, 'user', 'one more thought');
      await db.exec(`update public.documents set last_turn_at = now() - interval '2 hours'`);
      assert.equal((await pending(owner)).length, 1);
    });

    await t.test('the boundary only moves forward', async () => {
      // A pass that read less than an earlier one must not make turns the
      // earlier pass already handled pending all over again.
      const doc = await documentOf(call, owner);
      const turns = await call(owner, 'select * from document_content($1)', [doc.id]);
      await call(owner, 'select mark_document_consolidated($1,$2)',
        [doc.id, turns[turns.length - 1].id]);
      await call(owner, 'select mark_document_consolidated($1,$2)', [doc.id, 1]);
      assert.equal(Number((await documentOf(call, owner)).consolidated_through),
        Number(turns[turns.length - 1].id));
      assert.deepEqual(await pending(owner), []);
    });

    await t.test('and nobody else can move it', async () => {
      const doc = await documentOf(call, owner);
      await call(other, 'select mark_document_consolidated($1,$2)', [doc.id, 1]);
      assert.notEqual((await documentOf(call, owner)).consolidated_at, null);
    });
  } finally { await db.close(); }
});
