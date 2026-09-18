import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('Supabase-native tasks enforce grants, revisions, history, resources and idempotency',async t=>{
  const db=new PGlite();
  const owner=crypto.randomUUID(),other=crypto.randomUUID();
  const project=crypto.randomUUID(),otherProject=crypto.randomUUID();
  const client='task-agent';
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

    await call(user,'select create_project($1,$2,$3)',[project,'Tasks','Primary']);
    await call({sub:other},'select create_project($1,$2,$3)',[otherProject,'Other','Separate owner']);
    await call(user,'select authorize_agent_v2($1,$2,false,$3,false,$4,true,true)',[
      client,client,[],[project],
    ]);
    const hook=(await db.query('select satchel_access_token_hook($1) result',[
      {user_id:owner,client_id:client,claims:{sub:owner,client_id:client,aud:'authenticated'}},
    ])).rows[0].result.claims;
    await call({sub:other},'select authorize_agent_v2($1,$2,false,$3,false,false,$4,true,true)',[
      client,client,[],[otherProject],
    ]);
    const otherHook=(await db.query('select satchel_access_token_hook($1) result',[
      {user_id:other,client_id:client,claims:{sub:other,client_id:client,aud:'authenticated'}},
    ])).rows[0].result.claims;

    const taskId=crypto.randomUUID(),createRequest=crypto.randomUUID();
    const createArgs=[createRequest,taskId,project,'Ship task management','Continuity works','Avoid lost work',['MCP can resume'],'Implement the slice','high'];
    await t.test('create is idempotent and writes the first event atomically',async()=>{
      const created=await call(hook,'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',createArgs);
      assert.equal(created[0].revision,1);
      assert.equal((await call(hook,'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',createArgs))[0].revision,1);
      assert.equal((await call(hook,'select * from task_events where task_id=$1',[taskId])).length,1);
      await assert.rejects(call(hook,'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
        createRequest,taskId,project,'Different','','',[],'','medium',
      ]),{code:'PT409'});
    });

    await t.test('revision checks preserve the winning update and state event',async()=>{
      const request=crypto.randomUUID();
      const updated=await call(hook,'select * from transition_task($1,$2,1,$3,$4)',[
        request,taskId,'blocked','Waiting for review',
      ]);
      assert.equal(updated[0].status,'blocked');
      assert.equal(updated[0].revision,2);
      await assert.rejects(call(hook,'select * from transition_task($1,$2,1,$3,$4)',[
        crypto.randomUUID(),taskId,'ready','',
      ]),{code:'PT409'});
      const events=await call(hook,'select event_type,from_revision,to_revision from task_events where task_id=$1 order by id',[taskId]);
      assert.deepEqual(events.map(event=>event.event_type),['created','state_changed']);
    });

    let resourceId;
    await t.test('external resources are typed and handoffs return the new task projection',async()=>{
      resourceId=crypto.randomUUID();
      const added=(await call(hook,'select add_task_resource($1,$2,$3,2,$4,$5,$6,$7) result',[
        crypto.randomUUID(),resourceId,taskId,'Pull request','https://github.com/example/repo/pull/1','pull_request','github',
      ]))[0].result;
      assert.equal(added.resource.kind,'external_url');
      assert.equal(added.task.revision,3);
      const handoffId=crypto.randomUUID();
      const handed=(await call(hook,'select record_task_handoff($1,$2,$3,3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) result',[
        crypto.randomUUID(),handoffId,taskId,[],['Schema complete'],['Supabase is authoritative'],
        [{kind:'test',result:'pass'}],['UI'],[],'Build UI','Database slice complete','in_progress','',[resourceId],
      ]))[0].result;
      assert.equal(handed.task.revision,4);
      assert.equal(handed.task.status,'in_progress');
      assert.equal(handed.handoff.id,handoffId);
      assert.equal((await call(hook,'select * from handoff_resource_refs where handoff_id=$1',[handoffId])).length,1);
    });

    await t.test('comments stay lightweight while progress advances task state atomically',async()=>{
      const commentId=crypto.randomUUID(),commentRequest=crypto.randomUUID();
      const commentArgs=[commentRequest,commentId,taskId,'Review note from the implementation',[resourceId]];
      const comment=await call(hook,'select * from add_task_comment($1,$2,$3,$4,$5)',commentArgs);
      assert.equal(comment[0].kind,'comment');
      assert.equal((await call(hook,'select revision from tasks where id=$1',[taskId]))[0].revision,4);
      assert.equal((await call(hook,'select * from add_task_comment($1,$2,$3,$4,$5)',commentArgs))[0].id,commentId);
      assert.equal((await call(hook,'select * from task_update_resource_refs where update_id=$1',[commentId])).length,1);

      const progressId=crypto.randomUUID(),progressRequest=crypto.randomUUID();
      const progressArgs=[progressRequest,progressId,taskId,4,'UI work is underway',['Editor added'],['Keep updates append-only'],['Browser verification'],[],'Verify the flow','in_progress','',[resourceId]];
      const progress=(await call(hook,'select record_task_progress($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) result',progressArgs))[0].result;
      assert.equal(progress.task.revision,5);
      assert.equal(progress.task.next_action,'Verify the flow');
      assert.equal(progress.update.kind,'progress');
      assert.deepEqual(progress.update.completed,['Editor added']);
      assert.equal((await call(hook,'select record_task_progress($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) result',progressArgs))[0].result.update.id,progressId);
      await assert.rejects(call(hook,'select record_task_progress($1,$2,$3,4,$4,$5,$6,$7,$8,$9,$10,$11,$12) result',[
        crypto.randomUUID(),crypto.randomUUID(),taskId,'Stale update',[],[],[],[],'Nope',null,'',[],
      ]),{code:'PT409'});
    });

    let parentId,prerequisiteId;
    await t.test('planning graph enforces scope and cycles while deriving actionability',async()=>{
      parentId=crypto.randomUUID();prerequisiteId=crypto.randomUUID();
      for(const [id,title,next] of [[parentId,'Task management epic','Coordinate work'],[prerequisiteId,'Approve rollout','Review changes']])
        await call(hook,'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
          crypto.randomUUID(),id,project,title,'','',[],next,'medium',
        ]);

      const parentRequest=crypto.randomUUID();
      const parented=(await call(hook,'select set_task_parent($1,$2,5,$3) result',[
        parentRequest,taskId,parentId,
      ]))[0].result;
      assert.equal(parented.task.revision,6);
      assert.equal(parented.parent_id,parentId);
      assert.equal((await call(hook,'select set_task_parent($1,$2,5,$3) result',[
        parentRequest,taskId,parentId,
      ]))[0].result.parent_id,parentId);

      const dependency=(await call(hook,'select add_task_dependency($1,$2,6,$3) result',[
        crypto.randomUUID(),taskId,prerequisiteId,
      ]))[0].result;
      assert.equal(dependency.task.revision,7);
      let planning=(await call(hook,'select * from task_planning where id=$1',[taskId]))[0];
      assert.deepEqual(planning.blocked_by_ids,[prerequisiteId]);
      assert.equal(planning.actionable,false);

      await call(hook,'select * from transition_task($1,$2,1,$3,$4)',[
        crypto.randomUUID(),prerequisiteId,'done','',
      ]);
      planning=(await call(hook,'select * from task_planning where id=$1',[taskId]))[0];
      assert.deepEqual(planning.blocked_by_ids,[]);
      assert.equal(planning.actionable,true);

      await assert.rejects(call(hook,'select set_task_parent($1,$2,1,$3) result',[
        crypto.randomUUID(),parentId,taskId,
      ]),{code:'23514'});
      await assert.rejects(call(hook,'select add_task_dependency($1,$2,2,$3) result',[
        crypto.randomUUID(),prerequisiteId,taskId,
      ]),{code:'23514'});
      await assert.rejects(call(hook,'select set_task_parent($1,$2,7,$3) result',[
        crypto.randomUUID(),taskId,otherProject,
      ]),{code:'23514'});

      const removed=(await call(hook,'select remove_task_dependency($1,$2,7,$3) result',[
        crypto.randomUUID(),taskId,prerequisiteId,
      ]))[0].result;
      assert.equal(removed.task.revision,8);
      const restored=(await call(hook,'select add_task_dependency($1,$2,8,$3) result',[
        crypto.randomUUID(),taskId,prerequisiteId,
      ]))[0].result;
      assert.equal(restored.task.revision,9);
    });

    await t.test('task grant does not expose other owners or projects',async()=>{
      const otherTask=crypto.randomUUID();
      await call({sub:other},'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
        crypto.randomUUID(),otherTask,otherProject,'Other owner task','Private','',[],'Keep private','medium',
      ]);
      assert.deepEqual((await call(hook,'select id from projects')).map(row=>row.id),[project]);
      assert.equal((await call(hook,'select * from tasks')).length,3);
      assert.deepEqual(await call(otherHook,'select * from tasks where id=$1',[taskId]),[]);
      assert.deepEqual(await call(user,'select * from tasks where id=$1',[otherTask]),[]);
      assert.deepEqual(await call({sub:other},'select * from tasks where id=$1',[taskId]),[]);
      assert.deepEqual(await call({sub:other},'select * from task_handoffs where task_id=$1',[taskId]),[]);
      assert.deepEqual(await call({sub:other},'select * from task_resources where task_id=$1',[taskId]),[]);
      assert.deepEqual(await call({sub:other},'select * from task_updates where task_id=$1',[taskId]),[]);
      assert.deepEqual(await call({sub:other},'select * from task_events where task_id=$1',[taskId]),[]);
      await assert.rejects(call({sub:other},'select * from transition_task($1,$2,9,$3,$4)',[
        crypto.randomUUID(),taskId,'done','',
      ]),{code:'P0002'});
      await assert.rejects(call(hook,'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
        crypto.randomUUID(),crypto.randomUUID(),otherProject,'Nope','','',[],'','medium',
      ]),{code:'42501'});
    });

    await t.test('personal tasks need an explicit personal-task grant and retain child integrity',async()=>{
      const personalClient='personal-task-agent';
      await call(user,'select authorize_agent_v2($1,$2,false,$3,false,true,$4,true,true)',[
        personalClient,personalClient,[],[],
      ]);
      const personalHook=(await db.query('select satchel_access_token_hook($1) result',[
        {user_id:owner,client_id:personalClient,claims:{sub:owner,client_id:personalClient,aud:'authenticated'}},
      ])).rows[0].result.claims;
      assert.equal((await call(personalHook,'select agent_connection_status() result'))[0].result.task_personal,true);

      const personalTask=crypto.randomUUID();
      const created=await call(personalHook,'select * from create_task($1,$2,null,$3,$4,$5,$6,$7,$8)',[
        crypto.randomUUID(),personalTask,'Personal follow-up','Not tied to a project','',[],'Do it','medium',
      ]);
      assert.equal(created[0].project_id,null);
      const transitioned=await call(personalHook,'select * from transition_task($1,$2,1,$3,$4)',[
        crypto.randomUUID(),personalTask,'in_progress','',
      ]);
      assert.equal(transitioned[0].revision,2);
      assert.equal((await call(personalHook,'select * from tasks')).length,1);
      assert.equal((await call(hook,'select * from tasks where project_id is null')).length,0);
      const exported=(await call(user,'select export_tasks(null) result'))[0].result;
      assert.equal(exported.tasks.length,1);
      assert.equal(exported.tasks[0].id,personalTask);

      await assert.rejects(db.query(`insert into task_events(
        owner_id,project_id,task_id,event_type,to_revision,created_by
      ) values($1,$2,$3,'content_updated',3,'forged')`,[owner,project,personalTask]));
    });

    await t.test('file reservations use opaque paths and verify Storage metadata',async()=>{
      const resourceId=crypto.randomUUID(),requestId=crypto.randomUUID();
      const checksum='a'.repeat(64);
      const reserved=(await call(hook,'select reserve_task_file($1,$2,$3,9,$4,$5,$6,$7,$8,$9) result',[
        requestId,resourceId,taskId,'Build log','sensitive name.txt','text/plain',4,checksum,'document',
      ]))[0].result;
      assert.equal(reserved.task.revision,10);
      assert.equal(reserved.resource.object_key,`${owner}/${taskId}/${resourceId}`);
      assert.ok(!reserved.resource.object_key.includes('sensitive'));
      await db.query('insert into storage.objects values($1,$2,$3,$4)',[
        'task-files',reserved.resource.object_key,{size:4},{sha256:checksum},
      ]);
      const finalizeRequest=crypto.randomUUID();
      const verified=await call(hook,'select * from finalize_task_file($1,$2)',[finalizeRequest,resourceId]);
      assert.equal(verified[0].upload_status,'verified');
      assert.equal((await call(hook,'select * from finalize_task_file($1,$2)',[finalizeRequest,resourceId]))[0].upload_status,'verified');
      assert.equal((await call({sub:other},'select private.can_read_task_object($1) allowed',[reserved.resource.object_key]))[0].allowed,false);
      assert.equal((await call(otherHook,'select private.can_read_task_object($1) allowed',[reserved.resource.object_key]))[0].allowed,false);
      await assert.rejects(call(otherHook,'select * from finalize_task_file($1,$2)',[
        crypto.randomUUID(),resourceId,
      ]),{code:'42501'});
      await assert.rejects(call(hook,'select cleanup_task_file($1,$2)',[owner,resourceId]),{code:'42501'});
    });

    await t.test('read-only reauthorization invalidates the old generation and blocks writes',async()=>{
      await call(user,'select authorize_agent_v2($1,$2,false,$3,false,$4,false,false)',[
        client,client,[],[project],
      ]);
      assert.deepEqual(await call(hook,'select * from tasks'),[]);
      const fresh=(await db.query('select satchel_access_token_hook($1) result',[
        {user_id:owner,client_id:client,claims:{sub:owner,client_id:client,aud:'authenticated'}},
      ])).rows[0].result.claims;
      assert.equal((await call(fresh,'select * from tasks')).length,3);
      await assert.rejects(call(fresh,'select * from transition_task($1,$2,4,$3,$4)',[
        crypto.randomUUID(),taskId,'done','',
      ]),{code:'P0002'});
    });

    await t.test('export includes database records and immutable storage identities',async()=>{
      const exported=(await call(user,'select export_tasks($1) result',[project]))[0].result;
      assert.equal(exported.version,3);
      assert.equal(exported.tasks.length,3);
      assert.equal(exported.parent_edges[0].parent_task_id,parentId);
      assert.equal(exported.dependencies[0].depends_on_task_id,prerequisiteId);
      assert.equal(exported.resources[0].id,resourceId);
      assert.equal(exported.updates.length,2);
      assert.equal(exported.update_resource_refs.length,2);
      assert.ok(exported.events.some(event=>event.event_type==='parent_changed'));
      assert.ok(exported.events.some(event=>event.event_type==='dependency_added'));
    });
  } finally { await db.close(); }
});
