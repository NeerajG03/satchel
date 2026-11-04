import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '20000000-0000-4000-8000-000000000002';
const first = '40000000-0000-4000-8000-0000000000c1';
const second = '40000000-0000-4000-8000-0000000000c2';

test('drops become list lines, merged by title, ticked, moved and gone with their last drop', async t => {
  const db = new PGlite();
  async function as(id, sql, params = [], extra = {}) {
    await db.exec(`begin; set local role ${id ? 'authenticated' : 'anon'};`);
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(id ? {sub: id, ...extra} : {})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  const hint = async promise => { try { await promise; } catch (e) { return e.hint ?? e.message; } return 'no error'; };
  const save = (who, item, wants) => as(who, 'select save_shelf_wants($1,$2::jsonb) as n', [item, JSON.stringify(wants)]);
  const lines = who => as(who, 'select * from list_shelf_wants()');
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
    await applyMigrations(db);
    for (const id of [first, second])
      await as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6)', [id, 'note', `books ${id}`, null, null, null]);

    await t.test('a drop’s titles become lines once, and the same title from another drop joins its line', async () => {
      const [{n}] = await save(alice, first, [
        {list: 'Books', title: 'Piranesi', detail: 'Susanna Clarke', words: 'Piranesi'},
        {list: 'Watch', title: 'Dune (2021)', detail: null, words: 'Dune'},
        {list: '  ', title: 'x', words: 'x'}, {list: 'Books', title: '  !! ', words: ''}]);
      assert.equal(n, 2, 'a list with no name or a title with no letters is skipped');
      assert.equal((await save(alice, first, [{list: 'books', title: 'Another', words: 'a'}]))[0].n, 0, 'a drop is looked at once');
      const [{n: more}] = await save(alice, second, [{list: 'watch', title: 'the dune', words: 'the dune'},
        {list: 'books', title: 'Klara and the Sun', words: 'Klara'}, {list: 'Recipes to try', title: 'Shakshuka', words: 'shakshuka'}]);
      assert.equal(more, 2, '"the dune" on "watch" is the line "Dune (2021)" on "Watch"; a new list starts when needed');
      const names = await as(alice, 'select * from shelf_list_names()');
      assert.deepEqual(names.map(r => [r.list, r.lines]), [['Books', 2], ['Recipes to try', 1], ['Watch', 1]]);
      const dune = (await lines(alice)).find(l => l.list === 'Watch');
      assert.equal(dune.title, 'Dune (2021)');
      assert.equal(dune.item_ids.length, 2);
    });

    await t.test('a tick and a move; a move onto the same title merges the two', async () => {
      const book = (await lines(alice)).find(l => l.title === 'Piranesi');
      await as(alice, 'select set_shelf_want($1,$2)', [book.id, 'done']);
      assert.equal((await lines(alice)).find(l => l.id === book.id).status, 'done');
      assert.match(await hint(as(alice, 'select set_shelf_want($1,$2)', [book.id, 'maybe'])), /invalid:want/);
      const klara = (await lines(alice)).find(l => l.title === 'Klara and the Sun');
      const [{move_shelf_want: moved}] = await as(alice, 'select move_shelf_want($1,$2)', [klara.id, 'watch']);
      assert.equal(moved, klara.id);
      assert.equal((await lines(alice)).find(l => l.id === klara.id).list, 'Watch', 'joins the list by its existing name');
    });

    await t.test('nobody else sees, ticks or removes a line, and an app token gets nothing', async () => {
      const [line] = await lines(alice);
      assert.deepEqual(await lines(bob), []);
      assert.match(await hint(as(bob, 'select set_shelf_want($1,$2)', [line.id, 'done'])), /gone:want/);
      await as(bob, 'select remove_shelf_want($1)', [line.id]);
      assert.equal((await lines(alice)).length, 4);
      assert.notEqual(await hint(as(alice, 'select * from list_shelf_wants()', [], {client_id: 'app'})), 'no error');
      assert.match(await hint(save(bob, first, [{list: 'books', title: 'Mine', words: 'm'}])), /gone:shelf_item/);
    });

    await t.test('undo on a drop takes the lines only it made; removing the last drop takes the rest', async () => {
      await as(alice, 'select undo_shelf_wants($1)', [first]);
      const left = await lines(alice);
      assert.deepEqual(left.map(l => l.title).sort(), ['Dune (2021)', 'Klara and the Sun', 'Shakshuka'], 'Piranesi was only in the first drop');
      await as(alice, 'select * from remove_shelf_item($1)', [second]);
      assert.deepEqual(await lines(alice), []);
    });
  } finally { await db.close(); }
});
