// The turn boundary, against a real database.
//
// Nothing exercised session_window or the rolling window in SQL, which is the
// gap the last three memory bugs lived in: the MCP tests drive a fake service
// and the database tests never went through the handler, so a change that was
// right in one and wrong in the other passed both.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

test('a message is classified once, and only a real answer moves the boundary', async t => {
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
  const user = {sub: owner}, stranger = {sub: other};
  try {
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

    const say = (claims, role, content) =>
      call(claims, 'select record_session_message($1,$2,$3,$4)', ['s1', role, content, 10]);
    const windowOf = claims => call(claims, 'select * from session_window($1,$2)', ['s1', 10]);
    const unclassified = rows => rows.filter(r => r.classified_at === null)
      .filter(r => r.role === 'user').map(r => r.content).reverse();

    await say(user, 'user', 'what is the release order again');
    await say(user, 'assistant', 'Understood.');
    await say(user, 'user', 'never bump the Go version until payouts ship');
    await say(user, 'assistant', 'Noted.');

    // Turn one: both user messages are new, which is correct on a first Stop.
    let rows = await windowOf(user);
    assert.deepEqual(unclassified(rows),
      ['what is the release order again', 'never bump the Go version until payouts ship']);

    const newest = Math.max(...rows.map(r => Number(r.id)));
    const [{mark_session_classified: marked}] =
      await call(user, 'select mark_session_classified($1,$2)', ['s1', newest]);
    assert.equal(marked, 4, 'every row up to the boundary is marked, replies included');

    // Turn two: one new message. The old code offered the last five user
    // messages every time, so this is where the duplicate came from.
    await say(user, 'user', 'and never ship on a Friday');
    await say(user, 'assistant', 'Understood.');
    rows = await windowOf(user);
    assert.deepEqual(unclassified(rows), ['and never ship on a Friday'],
      'only what has not been classified is the turn');

    // Marking is idempotent, so a retry cannot double-count or reopen a row.
    const [{mark_session_classified: again}] =
      await call(user, 'select mark_session_classified($1,$2)', ['s1', newest]);
    assert.equal(again, 0, 'a row is classified once and stays classified');

    // Conversation text is the most sensitive thing Satchel holds, so the
    // marking routine has to be owner-scoped like everything that reads it.
    const [{mark_session_classified: theirs}] =
      await call(stranger, 'select mark_session_classified($1,$2)', ['s1', 9999]);
    assert.equal(theirs, 0, 'another account cannot touch this window');
    assert.deepEqual(await windowOf(stranger), [], 'nor read it');

    // And the boundary survives the trim, because a marked row aging out is
    // exactly what should happen to it.
    for (let i = 0; i < 12; i++) await say(user, 'user', `filler ${i}`);
    rows = await windowOf(user);
    assert.ok(rows.length <= 10, `the window stays short, got ${rows.length}`);
    assert.ok(!rows.some(r => r.content === 'never bump the Go version until payouts ship'),
      'a classified message is trimmed away rather than kept forever');
  } finally { await db.close(); }
});
