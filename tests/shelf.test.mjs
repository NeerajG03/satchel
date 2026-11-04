import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './helpers/migrations.mjs';
import { SUPABASE_STORAGE } from './helpers/storage.mjs';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const note = '40000000-0000-4000-8000-000000000001';
const photo = '40000000-0000-4000-8000-000000000002';
const other = '40000000-0000-4000-8000-000000000003';
const unit = i => `{${Array.from({ length: 768 }, (_, k) => (k === i ? 1 : 0)).join(',')}}`;

test('the shelf is its owner’s alone, and only from the web app', async t => {
  const db = new PGlite();
  async function as(id, sql, params = [], extra = {}) {
    await db.exec(`begin; set local role ${id ? 'authenticated' : 'anon'};`);
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify(id ? { sub: id, ...extra } : {})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  const app = { client_id: 'some-app' };
  const add = (owner, ...args) => as(owner, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6)', args);
  const hint = async promise => { try { await promise; } catch (e) { return e.hint ?? e.message; } return 'no error'; };
  try {
    await db.exec(`
      create role anon; create role authenticated; create role supabase_auth_admin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth, public to anon, authenticated;
      insert into auth.users values ('${alice}'), ('${bob}');
      ${SUPABASE_STORAGE}
      grant usage on schema storage to authenticated;
      grant select, insert on storage.objects to authenticated;
    `);
    await applyMigrations(db);

    await t.test('a note and a photo go on, and a retry hands back the same row', async () => {
      const [saved] = await add(alice, note, 'note', 'dentist moved to tuesday 3pm', null, null, null);
      assert.equal(saved.status, 'waiting');
      const [again] = await add(alice, note, 'note', 'dentist moved to tuesday 3pm', null, null, null);
      assert.equal(again.id, saved.id);
      await add(alice, photo, 'photo', '', `${alice}/${photo}.jpg`, 'image/jpeg', 2048);
      const rows = await as(alice, 'select * from list_shelf_items(10)');
      assert.deepEqual(rows.map(r => r.id).sort(), [note, photo].sort());
    });

    await t.test('reusing an id for something else is a conflict, not an overwrite', async () => {
      assert.equal(await hint(add(alice, note, 'note', 'something else', null, null, null)), 'satchel:conflict:shelf_request');
      assert.equal(await hint(add(bob, note, 'note', 'dentist moved to tuesday 3pm', null, null, null)), 'satchel:conflict:shelf_request');
    });

    await t.test('a file outside your own folder is refused', async () => {
      assert.equal(await hint(add(bob, other, 'photo', '', `${alice}/${other}.jpg`, 'image/jpeg', 10)), 'satchel:refused:shelf_path');
    });

    await t.test('another person sees nothing and cannot read, describe or remove it', async () => {
      assert.deepEqual(await as(bob, 'select * from list_shelf_items(10)'), []);
      assert.equal(await hint(as(bob, 'select * from claim_shelf_item($1)', [note])), 'satchel:gone:shelf_item');
      assert.equal(await hint(as(bob, 'select * from describe_shelf_item($1,$2,$3,$4)', [note, 'x', unit(0), 'm'])), 'satchel:gone:shelf_item');
      assert.deepEqual(await as(bob, 'select * from remove_shelf_item($1)', [note]), []);
      assert.equal((await as(alice, 'select * from list_shelf_items(10)')).length, 2);
    });

    await t.test('an app token and the anonymous role get nothing', async () => {
      assert.equal(await hint(as(alice, 'select * from list_shelf_items(10)', [], app)), 'satchel:app_token');
      assert.match(await hint(add(null, other, 'note', 'x', null, null, null)), /permission denied for function/);
      assert.match(await hint(as(alice, 'select * from shelf_items')), /permission denied/);
    });

    await t.test('an item is read once at a time, and never again once read', async () => {
      assert.equal(await hint(as(alice, 'select * from describe_shelf_item($1,$2,$3,$4)', [note, null, unit(0), 'model-a'])),
        'satchel:gone:shelf_item', 'only a claimed item takes a description');
      const [claimed] = await as(alice, 'select * from claim_shelf_item($1)', [note]);
      assert.equal(claimed.id, note);
      assert.equal(await hint(as(alice, 'select * from claim_shelf_item($1)', [note])), 'satchel:conflict:shelf_reading');
      await as(alice, 'select * from describe_shelf_item($1,$2,$3,$4)', [note, null, unit(0), 'model-a']);
      assert.equal(await hint(as(alice, 'select * from claim_shelf_item($1)', [note])), 'satchel:conflict:shelf_reading');
      assert.equal(await hint(as(alice, 'select * from describe_shelf_item($1,$2,$3,$4)', [note, null, null, null])),
        'satchel:gone:shelf_item', 'a late failure cannot wipe a finished read');
      await as(alice, 'select * from claim_shelf_item($1)', [photo]);
    });

    await t.test('search finds only described items of the same model, above the gate', async () => {
      const [failed] = await as(alice, 'select * from describe_shelf_item($1,$2,$3,$4)', [photo, null, null, null]);
      assert.equal(failed.status, 'failed');
      const [again] = await as(alice, 'select * from claim_shelf_item($1)', [photo]);
      assert.equal(again.id, photo, 'a failed read can be tried again');
      await as(alice, 'select * from describe_shelf_item($1,$2,$3,$4)', [photo, null, null, null]);
      const hits = await as(alice, 'select id, similarity from search_shelf($1,$2,20,0.5)', [unit(0), 'model-a']);
      assert.deepEqual(hits.map(h => h.id), [note]);
      assert.deepEqual(await as(alice, 'select id from search_shelf($1,$2,20,0.5)', [unit(0), 'model-b']), []);
      assert.deepEqual(await as(alice, 'select id from search_shelf($1,$2,20,0.5)', [unit(1), 'model-a']), [], 'below the gate stays quiet');
      assert.deepEqual(await as(bob, 'select id from search_shelf($1,$2,20,0.0)', [unit(0), 'model-a']), []);
    });

    await t.test('a read item’s note can be changed, with its new vector; not while it is arriving, and not by anyone else', async () => {
      assert.equal(await hint(as(alice, 'select * from edit_shelf_note($1,$2,$3,$4)', [note, 'dentist moved to wednesday', null, null])),
        'satchel:gone:shelf_item', 'a ready item needs its new vector');
      const [edited] = await as(alice, 'select * from edit_shelf_note($1,$2,$3,$4)', [note, '  dentist moved to wednesday ', unit(1), 'model-a']);
      assert.equal(edited.note, 'dentist moved to wednesday');
      assert.equal(await hint(as(bob, 'select * from edit_shelf_note($1,$2,$3,$4)', [note, 'mine now', unit(1), 'model-a'])), 'satchel:gone:shelf_item');
      assert.notEqual(await hint(as(alice, 'select * from edit_shelf_note($1,$2,$3,$4)', [note, '   ', unit(1), 'model-a'])), 'no error',
        'a note keeps some words');
      const arriving = '40000000-0000-4000-8000-0000000000b1';
      await add(alice, arriving, 'note', 'on its way', null, null, null);
      assert.equal(await hint(as(alice, 'select * from edit_shelf_note($1,$2,$3,$4)', [arriving, 'changed', null, null])), 'satchel:gone:shelf_item');
    });

    await t.test('storage takes a file only for a waiting row of the same person', async () => {
      const waiting = '40000000-0000-4000-8000-000000000004';
      await add(alice, waiting, 'voice', '', `${alice}/${waiting}.webm`, 'audio/webm', 100);
      const put = (who, name, extra) => as(who, "insert into storage.objects(bucket_id,name) values ('shelf',$1)", [name], extra);
      await put(alice, `${alice}/${waiting}.webm`);
      assert.match(await hint(put(alice, `${alice}/${photo}.jpg`)), /row-level security/, 'not waiting any more');
      assert.match(await hint(put(bob, `${alice}/${waiting}.webm`)), /row-level security/);
      assert.match(await hint(put(alice, `${alice}/${waiting}.webm`, app)), /row-level security/);
      assert.deepEqual(await as(bob, "select name from storage.objects where bucket_id = 'shelf'"), []);
      assert.equal((await as(alice, "select name from storage.objects where bucket_id = 'shelf'")).length, 1);
    });

    await t.test('a photo can carry one voice note: stored with it, uploaded while waiting, handed back on remove', async () => {
      const pic = '40000000-0000-4000-8000-0000000000a1';
      const voicePath = `${alice}/${pic}-voice.m4a`;
      await as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [pic, 'photo', '', `${alice}/${pic}.jpg`, 'image/jpeg', 900, voicePath, 'audio/mp4', 300]);
      const [again] = await as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [pic, 'photo', '', `${alice}/${pic}.jpg`, 'image/jpeg', 900, voicePath, 'audio/mp4', 300]);
      assert.equal(again.id, pic, 'a retry hands back the same row');
      assert.match(await hint(as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [pic, 'photo', '', `${alice}/${pic}.jpg`, 'image/jpeg', 900, null, null, null])), /shelf_request/, 'dropping the voice is a different thing');
      const put = name => as(alice, "insert into storage.objects(bucket_id,name) values ('shelf',$1)", [name]);
      await put(voicePath);
      const [listed] = await as(alice, 'select voice_path from list_shelf_items(50) where id = $1', [pic]);
      assert.equal(listed.voice_path, voicePath);
      const [claimed] = await as(alice, 'select * from claim_shelf_item($1)', [pic]);
      assert.deepEqual([claimed.voice_mime, claimed.voice_size], ['audio/mp4', 300]);
      const [gone] = await as(alice, 'select * from remove_shelf_item($1)', [pic]);
      assert.deepEqual([gone.object_path, gone.voice_path], [`${alice}/${pic}.jpg`, voicePath]);
    });

    await t.test('a voice note rides only a photo, and only from your own folder', async () => {
      const n = '40000000-0000-4000-8000-0000000000a2';
      assert.notEqual(await hint(as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [n, 'note', 'hello', null, null, null, `${alice}/${n}-voice.m4a`, 'audio/mp4', 300])), 'no error');
      assert.match(await hint(as(alice, 'select * from add_shelf_item($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [n, 'photo', '', `${alice}/${n}.jpg`, 'image/jpeg', 900, `${bob}/${n}-voice.m4a`, 'audio/mp4', 300])), /shelf_path/);
    });

    await t.test('removing hands back the file path for the Storage API', async () => {
      const [gone] = await as(alice, 'select * from remove_shelf_item($1)', [photo]);
      assert.equal(gone.object_path, `${alice}/${photo}.jpg`);
      assert.deepEqual((await as(alice, 'select id from list_shelf_items(10)')).map(r => r.id).includes(photo), false);
    });
  } finally { await db.close(); }
});
