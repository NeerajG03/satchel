import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

test('agent grants enforce isolation, writes, revocation and generation at the database boundary',async t=>{
  const db=new PGlite();
  const owner=crypto.randomUUID(), other=crypto.randomUUID(), a=crypto.randomUUID(),b=crypto.randomUUID();
  const ca='codex-fixture',cb='claude-fixture',taskClient='task-fixture';
  async function call(claims,sql,params=[]) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
      const result=await db.query(sql,params);await db.exec('commit');return result.rows;
    }catch(e){await db.exec('rollback');throw e;}
  }
  const user={sub:owner};let codex,claude,taskAgent;
  const authorize=(client,personal,projects,write)=>call(user,'select authorize_agent($1,$1,$2,$3,$4)',[client,personal,projects,write]);
  async function claims(client) {
    const {rows}=await db.query('select satchel_access_token_hook($1) result',[
      {user_id:owner,client_id:client,claims:{sub:owner,client_id:client,aud:'authenticated'}}]);
    return rows[0].result.claims;
  }
  try {
    await db.exec(`create role anon;create role authenticated;create role supabase_auth_admin;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;
      insert into auth.users values('${owner}'),('${other}');`);
    await applyMigrations(db);
    for(const id of [a,b]) await call(user,'select create_project($1,$2,$3)',[id,id,'']);
    await call(user,'select link_project_repository($1,$2,$3)',[a,'github','neerajg03/satchel']);
    for(const id of [null,a,b]) await call(user,'select save_memory($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),id,'Summary','','said',null,'same-name','PRIVATE DETAILS']);
    await authorize(ca,true,[a],false);await authorize(cb,false,[b],true);
    codex=await claims(ca);claude=await claims(cb);
    await call(user,'select authorize_agent_v2($1,$1,false,$2,false,false,$3,true,false)',[taskClient,[],[a]]);
    taskAgent=await claims(taskClient);
    await t.test('token hook leaves companion unchanged and binds OAuth grants/audience',async()=>{
      const event={user_id:owner,claims:{sub:owner,aud:'authenticated'}};
      assert.deepEqual((await db.query('select satchel_access_token_hook($1) result',[event])).rows[0].result,event);
      assert.ok(codex.aud.includes('https://satchel-pi.vercel.app/api/mcp'));
      assert.ok(codex.satchel_grant_id);
      await assert.rejects(call(user,'select satchel_access_token_hook($1)',[event]),{code:'42501'});
    });
    await t.test('only authorized scopes and metadata are returned; foreign owners remain hidden',async()=>{
      assert.equal((await call(codex,'select * from list_memories(null)')).length,1);
      assert.equal((await call(codex,'select * from list_memories($1)',[a])).length,1);
      assert.deepEqual(await call(codex,'select * from list_memories($1)',[b]),[]);
      assert.deepEqual((await call(codex,'select id from projects')).map(p=>p.id),[a]);
      assert.ok(!('more_info' in (await call(codex,'select * from list_memories(null)'))[0]));
      assert.deepEqual(await call({...codex,sub:other},'select * from memories'),[]);
      assert.deepEqual(await call({...codex,satchel_grant_id:crypto.randomUUID()},'select * from memories'),[]);
    });
    await t.test('connection rows and revoke operations remain owner-scoped even for the same client id',async()=>{
      await call({sub:other},'select authorize_agent($1,$1,true,$2,false)',[ca,[]]);
      const otherClaims=(await db.query('select satchel_access_token_hook($1) result',[
        {user_id:other,client_id:ca,claims:{sub:other,client_id:ca,aud:'authenticated'}},
      ])).rows[0].result.claims;
      assert.equal((await call(otherClaims,'select agent_connection_status() result'))[0].result.client_id,ca);
      assert.deepEqual(await call(otherClaims,'select * from memories'),[]);
      assert.equal((await call({sub:other},'select client_id from agent_connections')).length,1);
      await call({sub:other},'select revoke_agent($1)',[ca]);
      assert.notEqual((await call(codex,'select agent_connection_status() result'))[0].result,null);
      assert.equal((await call(otherClaims,'select agent_connection_status() result'))[0].result,null);
    });
    await t.test('read-only tokens cannot write through RPC or direct table operations',async()=>{
      await assert.rejects(call(codex,'select save_memory($1,null,$2)',[crypto.randomUUID(),'summary']),{code:'42501'});
      assert.deepEqual(await call(codex,"update memories set statement='hacked' returning id"),[]);
      assert.deepEqual(await call(codex,'delete from memories returning id'),[]);
      await assert.rejects(call(codex,'select authorize_agent($1,$1,true,$2,true)',[ca,[a,b]]),{code:'42501'});
      await assert.rejects(call(codex,'update agent_connections set can_write=true'),{code:'42501'});
    });
    await t.test('authorized writes retain idempotent saves and revision conflicts',async()=>{
      const id=crypto.randomUUID();const args=[id,b,'summary'];
      const first=await call(claude,'select * from save_memory($1,$2,$3)',args);
      assert.equal((await call(claude,'select * from save_memory($1,$2,$3)',args))[0].revision,1);
      assert.equal(first[0].project_id,b);
      assert.equal((await call(claude,'select * from correct_memory($1,1,$2,$3,$4)',[id,'corrected','new','detail']))[0].revision,2);
      await assert.rejects(call(claude,'select correct_memory($1,1,$2,$3,$4)',[id,'stale','new','detail']),{code:'PT409'});
      assert.deepEqual(await call(claude,'delete from memories where id=$1 and revision=1 returning id',[id]),[]);
      assert.equal((await call(claude,'delete from memories where id=$1 and revision=2 returning id',[id])).length,1);
      await assert.rejects(call(claude,'select save_memory($1,null,$2)',[crypto.randomUUID(),'summary']),{code:'42501'});
    });
    await t.test('project upserts create atomically without expanding grants and update only authorized projects',async()=>{
      const createdId=crypto.randomUUID(),requestId=crypto.randomUUID();
      await assert.rejects(call(codex,'select upsert_project($1,$2,null,$3,$4,$5,$6)',[
        crypto.randomUUID(),crypto.randomUUID(),'Denied','','unchanged',null]),{code:'42501'});
      const created=(await call(claude,'select upsert_project($1,$2,null,$3,$4,$5,$6) result',[
        requestId,createdId,'Agent project','Created atomically','link','agent/project']))[0].result;
      assert.equal(created.project.id,createdId);
      assert.equal(created.project.revision,1);
      assert.equal(created.grant_required,true);
      assert.deepEqual(created.repositories,[{provider:'github',repository:'agent/project'}]);
      assert.deepEqual((await call(claude,'select id from projects where id=$1',[createdId])),[]);
      assert.equal((await call(user,'select project_id from project_repositories where repository=$1',['agent/project']))[0].project_id,createdId);
      assert.deepEqual((await call(claude,'select upsert_project($1,$2,null,$3,$4,$5,$6) result',[
        requestId,createdId,'Agent project','Created atomically','link','agent/project']))[0].result,created);
      await assert.rejects(call(claude,'select upsert_project($1,$2,null,$3,$4,$5,$6)',[
        requestId,createdId,'Changed payload','Created atomically','link','agent/project']),{code:'PT409'});

      const updated=(await call(claude,'select upsert_project($1,$2,1,$3,$4,$5,$6) result',[
        crypto.randomUUID(),b,'Renamed project','Updated safely','unchanged',null]))[0].result;
      assert.equal(updated.project.revision,2);
      assert.equal(updated.project.name,'Renamed project');
      assert.equal(updated.grant_required,false);
      await assert.rejects(call(claude,'select upsert_project($1,$2,1,$3,$4,$5,$6)',[
        crypto.randomUUID(),b,'Stale update','','unchanged',null]),{code:'PT409'});
      await assert.rejects(call(claude,'select upsert_project($1,$2,1,$3,$4,$5,$6)',[
        crypto.randomUUID(),a,'Outside grant','','unchanged',null]),{code:'42501'});
      const taskAuthorized=(await call(taskAgent,'select upsert_project($1,$2,1,$3,$4,$5,$6) result',[
        crypto.randomUUID(),a,'Task-authorized project','','unchanged',null]))[0].result;
      assert.equal(taskAuthorized.project.revision,2);
      assert.equal(taskAuthorized.grant_required,false);
    });
    await t.test('active scopes belong to one client and conversation, never a global project',async()=>{
      await call(codex,'select select_agent_project($1,$2)',['session-one',a]);
      assert.equal((await call(codex,'select agent_active_project($1) id',['session-one']))[0].id,a);
      assert.equal((await call(codex,'select agent_active_project($1) id',['session-two']))[0].id,null);
      assert.equal((await call(claude,'select agent_active_project($1) id',['session-one']))[0].id,null);
      await assert.rejects(call(codex,'select select_agent_project($1,$2)',['session-one',b]),{code:'42501'});
    });
    await t.test('repository links activate only an already-authorized project',async()=>{
      assert.equal((await call(codex,'select select_agent_repository($1,$2,$3) id',
        ['repository-session','github','NeerajG03/Satchel']))[0].id,a);
      assert.equal((await call(codex,'select agent_active_project($1) id',['repository-session']))[0].id,a);
      await assert.rejects(call(claude,'select select_agent_repository($1,$2,$3)',
        ['repository-session','github','neerajg03/satchel']),{code:'P0002'});
      await assert.rejects(call(codex,'select link_project_repository($1,$2,$3)',
        [a,'github','other/repository']),{code:'42501'});
    });
    await t.test('anonymous lifecycle hints activate only through an authorized agent grant',async()=>{
      const session='40000000-0000-4000-8000-000000000001';
      await db.exec('begin; set local role anon;');
      try {
        await db.query("select set_config('request.jwt.claims','{}',true)");
        await db.query('select stage_agent_repository_hint($1,$2,$3)',[session,'github','NeerajG03/Satchel']);
        await db.exec('commit');
      }catch(e){await db.exec('rollback');throw e;}
      assert.equal((await call(codex,'select agent_repository_hint_exists($1) ready',[session]))[0].ready,true);
      assert.equal((await call(codex,'select activate_agent_repository_hint($1) id',[session]))[0].id,a);
      assert.equal((await call(codex,'select agent_repository_hint_exists($1) ready',[session]))[0].ready,false);
      assert.equal((await call(codex,'select agent_active_project($1) id',[session]))[0].id,a);
      assert.equal((await call(codex,'select activate_agent_repository_hint($1) id',[session]))[0].id,null);

      const denied='40000000-0000-4000-8000-000000000002';
      await db.exec('begin; set local role anon;');
      try {
        await db.query("select set_config('request.jwt.claims','{}',true)");
        await db.query('select stage_agent_repository_hint($1,$2,$3)',[denied,'github','neerajg03/satchel']);
        await db.exec('commit');
      }catch(e){await db.exec('rollback');throw e;}
      assert.equal((await call(claude,'select activate_agent_repository_hint($1) id',[denied]))[0].id,null);
      await assert.rejects(call({},'select activate_agent_repository_hint($1)',[crypto.randomUUID()]),{code:'42501'});
      await db.exec('begin; set local role anon;');
      try {
        await db.query("select set_config('request.jwt.claims','{}',true)");
        await assert.rejects(db.query('select * from agent_repository_hints'),{code:'42501'});
        await db.exec('rollback');
      }catch(e){await db.exec('rollback');throw e;}
    });
    // Deliberately after the hint tests above, which assume this repository
    // names exactly one project. A project is a collection of context, so a
    // monorepo holds several and a codebase can belong to more than one. That
    // used to raise PT409.
    await t.test('a repository may name several projects, and ambiguity is per connection',async()=>{
      await call(user,'select link_project_repository($1,$2,$3)',[b,'github','neerajg03/satchel']);
      assert.equal((await call(user,
        'select count(*)::int n from project_repositories where repository=$1',
        ['neerajg03/satchel']))[0].n,2,'a second project is a second row, not a refusal');

      // The companion sees both links, so the repository stops being an
      // identifier and is refused. `select ... into` would have taken whichever
      // row came back first, which makes the scope depend on the planner.
      await assert.rejects(call(user,'select select_agent_repository($1,$2,$3)',
        ['ambiguous-session','github','neerajg03/satchel']),{code:'PT300'});

      // Each grant still sees exactly one, because RLS exposes only the links
      // whose project it may already read. Ambiguity belongs to the connection,
      // not to the repository.
      assert.equal((await call(codex,'select select_agent_repository($1,$2,$3) id',
        ['codex-session','github','neerajg03/satchel']))[0].id,a);
      assert.equal((await call(claude,'select select_agent_repository($1,$2,$3) id',
        ['claude-session','github','neerajg03/satchel']))[0].id,b);

      // A connection that can read both is the case the hook has to handle. It
      // must not pick: a memory in a real project that is the wrong project is
      // worse than personal, which is at least visibly unscoped.
      const cc='both-fixture';
      await authorize(cc,false,[a,b],false);
      const both=await claims(cc);
      const session='40000000-0000-4000-8000-000000000003';
      await db.exec('begin; set local role anon;');
      try {
        await db.query("select set_config('request.jwt.claims','{}',true)");
        await db.query('select stage_agent_repository_hint($1,$2,$3)',[session,'github','neerajg03/satchel']);
        await db.exec('commit');
      }catch(e){await db.exec('rollback');throw e;}

      assert.equal((await call(both,'select activate_agent_repository_hint($1) id',[session]))[0].id,null,
        'two candidates is not a scope');
      assert.equal((await call(both,'select agent_active_project($1) id',[session]))[0].id,null,
        'and nothing is selected on the way out');
      // The hint survives, which is the whole reason activation reads before it
      // deletes: a consumed hint cannot be read back, and the candidates are
      // still the useful thing to offer.
      assert.equal((await call(both,'select agent_repository_hint_exists($1) ready',[session]))[0].ready,true);
      assert.deepEqual((await call(both,'select project_id from agent_repository_candidates($1)',[session]))
        .map(r=>r.project_id).sort(),[a,b].sort());
      // And it stays inside the grant: codex may read one of the two.
      assert.deepEqual((await call(codex,'select project_id from agent_repository_candidates($1)',[session]))
        .map(r=>r.project_id),[a]);
    });
    await t.test('revoke blocks an unexpired token immediately and re-consent cannot revive it',async()=>{
      await call(user,'select revoke_agent($1)',[ca]);
      assert.deepEqual(await call(codex,'select * from memories'),[]);
      assert.equal((await call(codex,'select agent_connection_status() status'))[0].status,null);
      assert.equal((await call(claude,'select * from list_memories($1)',[b])).length,1);
      await authorize(ca,true,[a],true);
      assert.deepEqual(await call(codex,'select * from memories'),[]);
      assert.equal((await call(await claims(ca),'select * from list_memories(null)')).length,1);
    });
    await t.test('a listed grant stays frozen: a project made later is not in it',async()=>{
      // This is the behaviour "select all" used to give everyone, and it is
      // still the right behaviour when a person picks projects one by one.
      const later=crypto.randomUUID();
      await call(user,'select create_project($1,$2,$3)',[later,'Made after the grant','']);
      assert.equal((await call(codex,'select agent_can_access($1,false) ok',[later]))[0].ok,false);
      assert.deepEqual(await call(codex,'select id from projects where id=$1',[later]),[]);
    });

    await t.test('a blanket grant covers a project that did not exist when it was given',async()=>{
      const blanket='blanket-fixture';
      await call(user,'select authorize_agent_v3($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [blanket,false,true,[],true,false,true,[],true,false]);
      const agent=await claims(blanket);
      const later=crypto.randomUUID();
      await call(user,'select create_project($1,$2,$3)',[later,'Created after the blanket grant','']);

      assert.equal((await call(agent,'select agent_can_access($1,false) ok',[later]))[0].ok,true);
      assert.equal((await call(agent,'select agent_can_access($1,true) ok',[later]))[0].ok,true);
      assert.equal((await call(agent,'select id from projects where id=$1',[later]))[0].id,later);
      // Tasks carry their capabilities per grant row, and a blanket grant has
      // no row, so the connection level flags have to answer instead.
      assert.equal((await call(agent,'select private.agent_can_access_tasks($1,$2) ok',[later,'read']))[0].ok,true);
      assert.equal((await call(agent,'select private.agent_can_access_tasks($1,$2) ok',[later,'write']))[0].ok,true);
      assert.equal((await call(agent,'select private.agent_can_access_tasks($1,$2) ok',[later,'upload']))[0].ok,false);

      const status=(await call(agent,'select agent_connection_status() s'))[0].s;
      assert.equal(status.all_projects,true,'the agent has to be able to tell a blanket grant from a list');
      assert.deepEqual(status.project_ids,[],'and a blanket grant keeps no stale list beside it');

      // Personal was not granted, so it is still a denial. Blanket means every
      // project, not everything.
      assert.equal((await call(agent,'select agent_can_access(null,false) ok'))[0].ok,false);
    });

    await t.test('a blanket grant is never handed out by a migration or an older client',async()=>{
      // Existing grants must not widen on their own. The column defaults to
      // false and the older signature has to keep meaning what it meant.
      assert.equal((await call(user,'select all_projects from agent_connections where client_id=$1',[ca]))[0].all_projects,false);
      await call(user,'select authorize_agent_v2($1,$1,false,$2,false,false,$3,true,false)',['blanket-fixture',[a],[a]]);
      assert.equal((await call(user,'select all_projects from agent_connections where client_id=$1',['blanket-fixture']))[0].all_projects,false,
        're-authorizing through the older signature must clear a blanket grant, not keep it');
      const agent=await claims('blanket-fixture');
      const later=(await call(user,'select id from projects where name=$1',['Created after the blanket grant']))[0].id;
      assert.equal((await call(agent,'select agent_can_access($1,false) ok',[later]))[0].ok,false);
    });

    await t.test('revoking a blanket grant denies it immediately',async()=>{
      const blanket='revoke-blanket';
      await call(user,'select authorize_agent_v3($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [blanket,false,true,[],false,false,false,[],false,false]);
      const agent=await claims(blanket);
      assert.equal((await call(agent,'select agent_can_access($1,false) ok',[a]))[0].ok,true);
      await call(user,'select revoke_agent($1)',[blanket]);
      assert.equal((await call(agent,'select agent_can_access($1,false) ok',[a]))[0].ok,false);
    });

    await t.test('a blanket grant still cannot reach another owner',async()=>{
      const foreign=crypto.randomUUID();
      await call({sub:other},'select create_project($1,$2,$3)',[foreign,'Someone else project','']);
      const agent=await claims('revoke-blanket');
      assert.equal((await call(agent,'select agent_can_access($1,false) ok',[foreign]))[0].ok,false);
      assert.deepEqual(await call(agent,'select id from projects where id=$1',[foreign]),[]);
    });

    await t.test('grant creation cannot authorize a different owner project',async()=>{
      await assert.rejects(call({sub:other},'select authorize_agent($1,$1,false,$2,true)',[ca,[a]]),{code:'42501'});
    });
  }finally{await db.close();}
});
