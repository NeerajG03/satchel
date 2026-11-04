import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

test('a connected app reaches the Shelf only when its grant says so, and only to read and add notes', async t => {
  const db = new PGlite();
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  async function call(claims, sql, params = []) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      const result = await db.query(sql, params); await db.exec('commit'); return result.rows;
    } catch (e) { await db.exec('rollback'); throw e; }
  }
  const hint = async promise => { try { await promise; } catch (e) { return e.hint ?? e.message; } return 'no error'; };
  async function claims(client, sub = owner) {
    const {rows} = await db.query('select satchel_access_token_hook($1) result', [
      {user_id: sub, client_id: client, claims: {sub, client_id: client, aud: 'authenticated'}}]);
    return rows[0].result.claims;
  }
  const me = {sub: owner}, them = {sub: other};
  const consent = (who, client, shelf) => call(who, 'select authorize_agent_v5($1,$2,$3,$4,$5,$6,$7)', [client, client, true, true, [], false, shelf]);
  const unit = '{' + Array.from({length: 768}, (_, i) => i === 0 ? 1 : 0).join(',') + '}';
  try {
    await db.exec(`create role anon;create role authenticated;create role supabase_auth_admin;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;
      insert into auth.users values('${owner}'),('${other}');`);
    await applyMigrations(db);
    const book = crypto.randomUUID(), theirs = crypto.randomUUID();
    await call(me, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6)', [book, 'note', 'read Piranesi someday', null, null, null]);
    await call(me, 'select * from claim_shelf_item($1)', [book]);
    await call(me, 'select * from describe_shelf_item($1,$2,$3,$4)', [book, null, unit, 'model-a']);
    await call(me, 'select save_shelf_wants($1,$2::jsonb)', [book, JSON.stringify([{list: 'Books', title: 'Piranesi', words: 'Piranesi'}])]);
    await call(them, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6)', [theirs, 'note', 'their secret plan', null, null, null]);

    await consent(me, 'claude-code', true);
    await consent(me, 'codex', false);
    await consent(them, 'claude-code', true);
    const claude = await claims('claude-code'), codex = await claims('codex'), theirClaude = await claims('claude-code', other);

    await t.test('the grant says whether the Shelf is allowed', async () => {
      assert.equal((await call(claude, 'select agent_connection_status() s'))[0].s.shelf, true);
      assert.equal((await call(codex, 'select agent_connection_status() s'))[0].s.shelf, false);
    });

    await t.test('allowed: search, read lists and add a note, all on its own person’s Shelf', async () => {
      const found = await call(claude, 'select * from agent_search_shelf($1,$2,$3,$4)', [unit, 'model-a', 10, 0.5]);
      assert.deepEqual(found.map(r => r.note), ['read Piranesi someday']);
      assert.deepEqual((await call(claude, 'select * from agent_shelf_lists($1)', ['books'])).map(r => r.title), ['Piranesi']);
      const id = crypto.randomUUID();
      const [added] = await call(claude, 'select * from agent_add_shelf_note($1,$2)', [id, ' remind me about the Dune sequel ']);
      assert.equal(added.status, 'waiting');
      assert.equal((await call(claude, 'select * from agent_add_shelf_note($1,$2)', [id, 'remind me about the Dune sequel']))[0].id, id, 'a retry is the same row');
      const [row] = await call(me, 'select added_by, note from list_shelf_items(10) where id = $1', [id]);
      assert.deepEqual([row.added_by, row.note], ['claude-code', 'remind me about the Dune sequel']);
      assert.match(await hint(call(claude, 'select * from agent_add_shelf_note($1,$2)', [crypto.randomUUID(), '   '])), /invalid:shelf_note/);
      assert.match(await hint(call(claude, 'select * from agent_add_shelf_note($1,$2)', [theirs, 'take it over'])), /conflict:shelf_request/,
        'another person’s id is never overwritten');
    });

    await t.test('not allowed, stale or revoked: refused; another person’s Shelf: never', async () => {
      for (const sql of ['select * from agent_shelf_lists(null)', `select * from agent_add_shelf_note('${crypto.randomUUID()}','x')`])
        assert.match(await hint(call(codex, sql)), /refused:shelf/);
      assert.match(await hint(call({...claude, satchel_grant_id: crypto.randomUUID()}, 'select * from agent_shelf_lists(null)')), /refused:shelf/);
      assert.deepEqual((await call(theirClaude, 'select * from agent_search_shelf($1,$2,$3,$4)', [unit, 'model-a', 10, 0])).map(r => r.note), []);
      assert.deepEqual(await call(theirClaude, 'select * from agent_shelf_lists(null)'), []);
      await call(me, 'select revoke_agent($1)', ['claude-code']);
      assert.match(await hint(call(claude, 'select * from agent_shelf_lists(null)')), /refused:shelf/);
    });

    await t.test('the person’s own Shelf routines still refuse an app token', async () => {
      const fresh = await (async () => { await consent(me, 'claude-code', true); return claims('claude-code'); })();
      assert.notEqual(await hint(call(fresh, 'select * from list_shelf_items(10)')), 'no error');
      assert.notEqual(await hint(call(fresh, 'select * from remove_shelf_item($1)', [book])), 'no error');
      assert.notEqual(await hint(call(fresh, 'select set_shelf_want(id, $1) from list_shelf_wants()', ['done'])), 'no error');
    });
  } finally { await db.close(); }
});
