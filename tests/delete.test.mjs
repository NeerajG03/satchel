import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';
import {SUPABASE_STORAGE} from './helpers/storage.mjs';

test('people can delete topics with a revision check; agents cannot',async t=>{
  const db=new PGlite();
  const owner=crypto.randomUUID(),other=crypto.randomUUID();
  const topic=crypto.randomUUID();
  const client='delete-agent';
  async function call(claims,sql,params=[]) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
      const result=await db.query(sql,params);
      await db.exec('commit');
      return result.rows;
    } catch(error) { await db.exec('rollback'); throw error; }
  }
  const user={sub:owner};
  try {
    await db.exec(`
      create role anon; create role authenticated; create role supabase_auth_admin;
      create schema auth;
      ${SUPABASE_STORAGE}
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as
        $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;
      insert into auth.users values('${owner}'),('${other}');
    `);
    // Through the shared helper, which shims pgvector. PGlite has no such
    // extension, so an inlined loop stops working the moment a migration
    // creates one.
    await applyMigrations(db);

    await call(user,'select create_topic($1,$2,$3)',[topic,'Doomed','Will be deleted']);
    await call(user,'select authorize_agent_v4($1,$2,false,false,$3,true)',[client,client,[topic]]);
    const hook=(await db.query('select satchel_access_token_hook($1) result',[
      {user_id:owner,client_id:client,claims:{sub:owner,client_id:client,aud:'authenticated'}},
    ])).rows[0].result.claims;
    // The v2 signature: a memory is one statement, with source, band and an
    // optional handle after it.
    await call(user,'select save_memory($1,$2,$3,$4,$5,$6,$7)',
      [crypto.randomUUID(),topic,'Kept short','Kept short','said',null,'Decision']);

    await t.test('agent tokens are refused, even with write access to the topic',async()=>{
      await assert.rejects(call(hook,'select delete_topic($1,1)',[topic]),{code:'42501'});
    });

    await t.test('a stale revision is a conflict, a wrong owner is not found',async()=>{
      await assert.rejects(call(user,'select delete_topic($1,99)',[topic]),{code:'PT409'});
      await assert.rejects(call({sub:other},'select delete_topic($1,1)',[topic]),{code:'P0002'});
    });

    await t.test('deleting a topic takes its memories and its grants with it',async()=>{
      const [{revision}]=await call(user,'select revision from topics where id=$1',[topic]);
      const result=(await call(user,'select delete_topic($1,$2) result',[topic,revision]))[0].result;
      assert.deepEqual(Object.keys(result).sort(),['id','memories_removed','name']);
      assert.equal(result.name,'Doomed');
      assert.equal(result.memories_removed,1);
      assert.equal((await call(user,'select id from memories where topic_id=$1',[topic])).length,0);
      assert.deepEqual((await call(user,'select topic_ids from agent_connections where client_id=$1',[client]))[0].topic_ids,[]);
    });
  } finally { await db.close(); }
});
