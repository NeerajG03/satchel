import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('people can delete tasks and projects with a revision check; agents cannot',async t=>{
  const db=new PGlite();
  const owner=crypto.randomUUID(),other=crypto.randomUUID();
  const project=crypto.randomUUID();
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
      create schema storage;
      create table storage.objects(bucket_id text,name text,metadata jsonb,user_metadata jsonb);
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as
        $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;
      insert into auth.users values('${owner}'),('${other}');
    `);
    const dir=new URL('../supabase/migrations/',import.meta.url);
    for(const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort())
      await db.exec(await readFile(new URL(file,dir),'utf8'));

    await call(user,'select create_project($1,$2,$3)',[project,'Doomed','Will be deleted']);
    await call(user,'select authorize_agent_v2($1,$2,false,$3,false,$4,true,true)',[client,client,[],[project]]);
    const hook=(await db.query('select satchel_access_token_hook($1) result',[
      {user_id:owner,client_id:client,claims:{sub:owner,client_id:client,aud:'authenticated'}},
    ])).rows[0].result.claims;

    const parent=crypto.randomUUID(),child=crypto.randomUUID(),personal=crypto.randomUUID();
    await call(user,'select create_task($1,$2,$3,$4)',[crypto.randomUUID(),parent,project,'Parent']);
    await call(user,'select create_task($1,$2,$3,$4)',[crypto.randomUUID(),child,project,'Child']);
    await call(user,'select create_task($1,$2,null,$3)',[crypto.randomUUID(),personal,'Personal']);
    await call(user,'select set_task_parent($1,$2,1,$3)',[crypto.randomUUID(),child,parent]);
    await call(user,'select save_memory($1,$2,$3,$4,$5)',[crypto.randomUUID(),project,'Decision','Kept short','']);
    const resource=crypto.randomUUID();
    await call(user,'select reserve_task_file($1,$2,$3,1,$4,$5,$6,$7,$8,$9)',[
      crypto.randomUUID(),resource,parent,'Notes','notes.txt','text/plain',5,'a'.repeat(64),'document']);
    const key=(await call(user,'select object_key from task_resources where id=$1',[resource]))[0].object_key;
    await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['task-files',key]);

    await t.test('agent tokens are refused',async()=>{
      await assert.rejects(call(hook,'select delete_task($1,2)',[parent]),{code:'42501'});
      await assert.rejects(call(hook,'select delete_project($1,1)',[project]),{code:'42501'});
    });

    await t.test('a stale revision is a conflict, a wrong owner is not found',async()=>{
      await assert.rejects(call(user,'select delete_task($1,1)',[parent]),{code:'PT409'});
      await assert.rejects(call({sub:other},'select delete_task($1,2)',[parent]),{code:'P0002'});
    });

    await t.test('deleting a task removes its rows and files and frees its children',async()=>{
      const result=(await call(user,'select delete_task($1,2) result',[parent]))[0].result;
      assert.equal(result.title,'Parent');
      assert.equal(result.files_removed,1);
      assert.equal(result.children_unparented,1);
      assert.equal((await call(user,'select id from tasks where id=$1',[parent])).length,0);
      assert.equal((await call(user,'select id from task_resources where task_id=$1',[parent])).length,0);
      assert.equal((await db.query('select name from storage.objects where name=$1',[key])).rows.length,0);
      assert.equal((await call(user,'select parent_id from task_planning where id=$1',[child]))[0].parent_id,null);
    });

    await t.test('deleting a project takes its memories, tasks and grants with it',async()=>{
      const result=(await call(user,'select delete_project($1,1) result',[project]))[0].result;
      assert.equal(result.name,'Doomed');
      assert.equal(result.memories_removed,1);
      assert.equal(result.tasks_removed,1);
      assert.equal((await call(user,'select id from tasks where project_id=$1',[project])).length,0);
      assert.equal((await call(user,'select id from memories where project_id=$1',[project])).length,0);
      assert.equal((await db.query('select 1 from agent_task_grants where project_id=$1',[project])).rows.length,0);
      assert.deepEqual((await call(user,'select project_ids from agent_connections where client_id=$1',[client]))[0].project_ids,[]);
      assert.equal((await call(user,'select id from tasks where id=$1',[personal])).length,1);
    });
  } finally { await db.close(); }
});
