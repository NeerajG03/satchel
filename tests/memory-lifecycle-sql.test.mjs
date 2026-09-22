// A memory can end without being destroyed, and nothing changes it silently.
//
// The two properties here are the ones that make auto-applied consolidation
// safe to switch on: what ends is still there, and every change left a record
// of who made it and why. Both are easy to have in the design and not have in
// the database, which is why they are tested against a real one.
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
  async function call(sub, sql, params = [], clientId) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({sub, ...(clientId ? {client_id: clientId} : {})})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  return {db, owner, other, call};
}

const save = (call, sub, id, statement) =>
  call(sub, 'select * from save_memory($1,$2,$3,$4,$5)', [id, null, statement, 'they said so', 'said']);
const history = (call, sub, id) => call(sub, 'select * from memory_history($1)', [id]);
const live = (call, sub) => call(sub, 'select * from personal_memories()');

test('a memory that ends is archived, not destroyed', async t => {
  const {db, owner, call} = await database();
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  try {
    await save(call, owner, first, 'Entries are immutable.');
    await save(call, owner, second, 'Corrections are a new reversing entry.');

    await t.test('replacing one points at what replaced it', async () => {
      await call(owner, 'select * from end_memory($1,$2,$3,$4,$5)',
        [first, 1, 'replaced', second, 'the user said corrections are reversing entries']);
      const rows = await live(call, owner);
      assert.deepEqual(rows.map(r => r.statement), ['Corrections are a new reversing entry.'],
        'what ended does not load');
      const [archived] = await call(owner, 'select * from archived_memories()');
      assert.equal(archived.id, first, 'and it is still there');
      assert.equal(archived.ended_reason, 'replaced');
      assert.equal(archived.ended_by, second, 'pointing at the row that replaced it');
      assert.equal(archived.statement, 'Entries are immutable.', 'in its own original words');
    });

    await t.test('ending it twice is a conflict, not a second ending', async () => {
      await assert.rejects(call(owner, 'select * from end_memory($1,$2,$3)', [first, 2, 'forgotten']),
        {code: 'PT409'});
    });

    await t.test('only a replacement may name what replaced it', async () => {
      const third = crypto.randomUUID();
      await save(call, owner, third, 'I want entries append only.');
      await assert.rejects(
        call(owner, 'update memories set ended_at=now(), ended_reason=$1, ended_by=$2 where id=$3',
          ['retired', second, third]),
        {code: '23514'});
    });

    await t.test('a fulfilled intent is retired, which is not the same as being wrong', async () => {
      const [{id}] = await call(owner,
        `select id from memories where statement='I want entries append only.'`);
      await call(owner, 'select * from end_memory($1,$2,$3,$4,$5)',
        [id, 1, 'retired', null, 'the user said it was done']);
      const [row] = await call(owner, 'select ended_reason, ended_by from memories where id=$1', [id]);
      assert.equal(row.ended_reason, 'retired');
      assert.equal(row.ended_by, null, 'nothing replaced it, it was simply spent');
    });
  } finally { await db.close(); }
});

test('every change to a memory leaves an event, whoever made it', async t => {
  const {db, owner, other, call} = await database();
  const id = crypto.randomUUID();
  try {
    await save(call, owner, id, 'No em dashes.');

    await t.test('saving one is the first event', async () => {
      const rows = await history(call, owner, id);
      assert.deepEqual(rows.map(r => r.action), ['added']);
      assert.equal(rows[0].after, 'No em dashes.');
      assert.match(rows[0].actor, /^user:/);
    });

    await t.test('a correction keeps both wordings', async () => {
      await call(owner, 'select * from correct_memory($1,$2,$3)', [id, 1, 'No em dashes anywhere.']);
      const rows = await history(call, owner, id);
      assert.deepEqual(rows.map(r => r.action), ['added', 'corrected']);
      assert.equal(rows[1].before, 'No em dashes.');
      assert.equal(rows[1].after, 'No em dashes anywhere.');
    });

    await t.test('an extension says so, and a correction does not claim to be one', async () => {
      await call(owner, 'select * from extend_memory($1,$2,$3)',
        [id, 2, 'No em dashes anywhere, including in commit messages.']);
      const rows = await history(call, owner, id);
      assert.deepEqual(rows.map(r => r.action), ['added', 'corrected', 'extended']);
      assert.equal((await call(owner, 'select mentions from memories where id=$1', [id]))[0].mentions, 2,
        'saying it again is evidence, and it counts');
    });

    await t.test('a write straight at the table is still an event', async () => {
      // The reason this is a trigger. Capture shipped for weeks without
      // embedding its own rows because the one writer nobody checks is the one
      // that quietly skips a step.
      await call(owner, `update memories set statement='Went around the routine.' where id=$1`, [id]);
      const rows = await history(call, owner, id);
      assert.equal(rows.length, 4);
      assert.equal(rows[3].action, 'corrected');
    });

    await t.test('bookkeeping is not a change', async () => {
      const before = (await history(call, owner, id)).length;
      await call(owner, 'select * from affirm_memory($1)', [id]);
      await call(owner, `update memories set expires_at = now() + interval '1 day' where id=$1`, [id]);
      assert.equal((await history(call, owner, id)).length, before,
        'saying it again and setting an expiry do not rewrite what it says');
      const [row] = await call(owner, 'select revision from memories where id=$1', [id]);
      assert.equal(row.revision, 4, 'and they do not move the revision anyone is holding');
    });

    await t.test('agreeing to an unconfirmed one is an event of its own', async () => {
      // Promotion is the only thing that gets a heard memory loading at
      // session start again, so it has to be visible in the history.
      const heard = crypto.randomUUID();
      await call(owner, 'select * from save_memory($1,$2,$3,$4,$5)',
        [heard, null, 'Picked up in passing.', 'they said so', 'heard']);
      await call(owner, 'select * from confirm_memory($1,$2)', [heard, 1]);
      assert.deepEqual((await history(call, owner, heard)).map(r => r.action), ['added', 'confirmed']);
    });

    await t.test('nobody else can read any of it', async () => {
      assert.deepEqual(await history(call, other, id), []);
      assert.deepEqual(await call(other, 'select * from memory_events'), []);
    });
  } finally { await db.close(); }
});

test('an automatic write carries the run that made it', async () => {
  // R11. A background pass writes memory while nobody is watching, so a row
  // and the reasoning behind it have to be one step apart in both directions.
  const {db, owner, call} = await database();
  const id = crypto.randomUUID(), trace = 'b3a1f0c2d4e5';
  try {
    await call(owner, 'select record_turn($1,$2,$3,$4,$5)', ['s1', 'user', 'no em dashes', 10, null]);
    const [doc] = await call(owner, 'select * from session_document($1)', ['s1']);
    await call(owner, 'select * from capture_memory($1,$2,$3,$4,$5,$6,$7)',
      [id, 'No em dashes anywhere.', 'no em dashes', null, 'preference', trace, doc.id]);
    const [event] = await history(call, owner, id);
    assert.equal(event.action, 'added');
    assert.equal(event.trace_id, trace, 'the trace that decided this is on the row');
    assert.equal(event.document_id, doc.id, 'and so is the conversation it came out of');
    const [row] = await call(owner, 'select kind, band, revision from memories where id=$1', [id]);
    assert.equal(row.kind, 'preference');
    assert.equal(row.revision, 1, 'the kind is part of the write, not a correction after it');
    assert.equal(row.band, 'heard', 'captured is still unconfirmed');
  } finally { await db.close(); }
});

test('an expired memory stops loading without anything being written', async () => {
  const {db, owner, call} = await database();
  const id = crypto.randomUUID();
  try {
    await save(call, owner, id, 'The freeze is on until the 30th.');
    await call(owner, `update memories set expires_at = now() - interval '1 second' where id=$1`, [id]);
    assert.deepEqual(await live(call, owner), [], 'it does not load');
    assert.deepEqual((await call(owner, 'select * from list_memories(null)')).map(r => r.id), []);
    const [archived] = await call(owner, 'select * from archived_memories()');
    assert.equal(archived.id, id, 'it is archive, not deletion');
    assert.equal(archived.ended_at, null, 'and nothing happened to it, time passed');
  } finally { await db.close(); }
});

test('deleting a memory is the one thing that destroys, and only a person can', async () => {
  const {db, owner, call} = await database();
  const id = crypto.randomUUID();
  try {
    await save(call, owner, id, 'Something private.');
    assert.equal((await history(call, owner, id)).length, 1);
    await call(owner, 'delete from memories where id=$1', [id]);
    const [{count}] = (await db.query('select count(*)::int from public.memory_events')).rows;
    assert.equal(count, 0, 'the history of a thing they asked to be gone goes with it');
  } finally { await db.close(); }
});
