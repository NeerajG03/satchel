import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations, RETRIEVAL} from './helpers/migrations.mjs';

const alice='10000000-0000-4000-8000-000000000001';
const bob  ='10000000-0000-4000-8000-000000000002';
const projectA='20000000-0000-4000-8000-00000000000a';
const projectB='20000000-0000-4000-8000-00000000000b';

// A tiny orthogonal basis keeps expected similarities obvious by inspection.
const vec=(a,b,c)=>`{${[a,b,c,...Array(765).fill(0)].join(',')}}`;

test('semantic retrieval respects scope, grants, the gate and the boost', async t => {
  const db=new PGlite();
  async function as(id, sql, params=[], clientId){
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({sub:id,...(clientId?{client_id:clientId,satchel_grant_id:grantId}:{})})]);
      const r=await db.query(sql,params);
      await db.exec('commit');
      return r.rows;
    } catch(e){ await db.exec('rollback'); throw e; }
  }
  let grantId=null;
  await db.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    insert into auth.users values ('${alice}'), ('${bob}');
  `);
  assert.ok((await applyMigrations(db)).includes(RETRIEVAL),'retrieval migration is missing');

  await as(alice,'select * from create_project($1,$2,$3)',[projectA,'Cardinal','Payments']);
  await as(alice,'select * from create_project($1,$2,$3)',[projectB,'Parcelping','Shipments']);
  await as(bob,  'select * from create_project($1,$2,$3)',['20000000-0000-4000-8000-0000000000bb','Other','Bob']);

  const rows=[
    ['30000000-0000-4000-8000-000000000001',projectA,'Idempotency keys are scoped to merchant plus key.',vec(1,0,0)],
    ['30000000-0000-4000-8000-000000000002',projectB,'The carrier API allows 50,000 lookups a month.',   vec(0,1,0)],
    ['30000000-0000-4000-8000-000000000003',null,    'Never use em dashes in anything written for me.',  vec(0,0,1)],
  ];
  for(const [id,scope,statement,embedding] of rows){
    await as(alice,'select * from save_memory($1,$2,$3)',[id,scope,statement]);
    await as(alice,`update memories set embedding=$2::extensions.vector,
      embedding_model='test', embedded_at=now() where id=$1`,[id,embedding]);
  }
  const search=(owner,q,opts={},clientId)=>as(owner,
    `select * from search_memories($1::extensions.vector,$2,$3,$4,$5,$6)`,
    [q,opts.inScope??null,opts.limit??5,opts.gate??0.5,opts.boost??1.1,opts.exclude??[]],clientId);

  await t.test('a query returns the semantically closest row', async () => {
    const r=await search(alice,vec(1,0,0));
    assert.equal(r.length,1);
    assert.equal(r[0].statement,'Idempotency keys are scoped to merchant plus key.');
    assert.ok(r[0].score>0.99,`expected near-1 similarity, got ${r[0].score}`);
  });

  await t.test('a null argument means the default, not silence', async () => {
    // `p_gate real default 0.67` only applies when the argument is absent. An
    // explicit NULL is not absent: the filter became `score >= NULL`, which is
    // NULL, which is not true, so every row was dropped and retrieval went
    // quiet everywhere. The caller no longer sends null, but the function has
    // to be safe for any caller that ever does.
    const nulled=await as(alice,
      `select * from search_memories($1::extensions.vector,null,null,null,null,null)`,[vec(1,0,0)]);
    assert.equal(nulled.length,1,'a null gate must fall back to the default, not exclude everything');
    assert.equal(nulled[0].statement,'Idempotency keys are scoped to merchant plus key.');
    // A null boost would otherwise turn every in-scope score into NULL, which
    // drops exactly the rows the boost was meant to favour.
    const inScope=await as(alice,
      `select * from search_memories($1::extensions.vector,$2,null,null,null,null)`,[vec(1,0,0),projectA]);
    assert.equal(inScope.length,1,'a null boost must not erase the in-scope rows it applies to');
    assert.ok(inScope[0].score>=nulled[0].score,'and the default boost still favours the scope');
  });

  await t.test('the gate excludes everything below it', async () => {
    assert.equal((await search(alice,vec(1,0,0),{gate:0.99})).length,1);
    assert.equal((await search(alice,vec(0.6,0.8,0),{gate:0.9})).length,0);
  });

  await t.test('counts describe the whole scope, not the returned page', async () => {
    const r=await search(alice,vec(1,1,1),{gate:0.1,limit:1});
    assert.equal(r.length,1,'limit caps the rows returned');
    assert.equal(r[0].matched,3,'matched counts everything over the gate');
    assert.equal(r[0].in_scope,3,'in_scope counts everything searchable');
  });

  await t.test('the in-scope project is boosted, and only that project', async () => {
    const q=vec(0.8,0.6,0.3);
    const byId=rows=>Object.fromEntries(rows.map(r=>[r.id,r.score]));
    const a='30000000-0000-4000-8000-000000000001';
    const b='30000000-0000-4000-8000-000000000002';
    const personal='30000000-0000-4000-8000-000000000003';
    const plain=byId(await search(alice,q,{gate:0,limit:50,boost:1}));
    const boosted=byId(await search(alice,q,{gate:0,limit:50,boost:1.5,inScope:projectB}));
    assert.ok(plain[a]>plain[b],'without a boost the closer row scores higher');
    assert.ok(boosted[b]>boosted[a],'a boost is enough to reorder');
    assert.equal(boosted[a],plain[a],'a row outside the boosted project is untouched');
    assert.equal(boosted[personal],plain[personal],'and so is a personal row');
    assert.ok(Math.abs(boosted[b]-plain[b]*1.5)<1e-5,'the boost is exactly the multiplier');
  });

  await t.test('excluded ids are never returned twice', async () => {
    const [first]=await search(alice,vec(1,0,0));
    const again=await search(alice,vec(1,0,0),{exclude:[first.id]});
    assert.equal(again.length,0);
  });

  await t.test('unembedded rows are invisible rather than wrong', async () => {
    const id='30000000-0000-4000-8000-00000000000f';
    await as(alice,'select * from save_memory($1,$2,$3)',[id,projectA,'Not embedded yet.']);
    const r=await search(alice,vec(1,0,0),{gate:0.1,limit:20});
    assert.ok(!r.some(x=>x.id===id),'a row without an embedding must not be returned');
    assert.equal(r[0].in_scope,3,'and must not inflate the in-scope count');
  });

  await t.test('another owner retrieves nothing of these', async () => {
    assert.deepEqual(await search(bob,vec(1,0,0),{gate:0.1,limit:20}),[]);
  });

  await t.test('an embedding cannot be stored without its model', async () => {
    const id='30000000-0000-4000-8000-0000000000aa';
    await as(alice,'select * from save_memory($1,$2,$3)',[id,projectA,'Needs an embedding.']);
    await assert.rejects(
      as(alice,`update memories set embedding=$2::extensions.vector where id=$1`,[id,vec(1,0,0)]),
      /memories_embedding_pairing/,'an embedding without its model must be refused');
    await as(alice,`update memories set embedding=$2::extensions.vector,
      embedding_model='test', embedded_at=now() where id=$1`,[id,vec(1,0,0)]);
    await assert.rejects(
      as(alice,`update memories set embedding_model=null where id=$1`,[id]),
      /memories_embedding_pairing/,'clearing only the model must be refused too');
  });

  await t.test('embedding a row is not an edit, so the revision and updated_at hold', async () => {
    // The revision is the optimistic concurrency token. If backfilling an
    // embedding bumps it, every client holding the old one gets a conflict it
    // cannot explain, and re-embedding after a model change does that to the
    // whole corpus at once.
    const id='30000000-0000-4000-8000-0000000000bb';
    await as(alice,'select * from save_memory($1,$2,$3)',[id,projectA,'Waiting to be embedded.']);
    const [before]=await as(alice,'select revision, updated_at from memories where id=$1',[id]);
    await as(alice,`update memories set embedding=$2::extensions.vector,
      embedding_model='gemini-embedding-001', embedded_at=now() where id=$1`,[id,vec(0,1,0)]);
    const [after]=await as(alice,'select revision, updated_at from memories where id=$1',[id]);
    assert.equal(after.revision,before.revision,'embedding must not bump the revision');
    assert.deepEqual(after.updated_at,before.updated_at,'and must not move updated_at');

    // Re-embedding under a new model is the case that would hit every row.
    await as(alice,`update memories set embedding=$2::extensions.vector,
      embedding_model='some-other-model', embedded_at=now() where id=$1`,[id,vec(0,0,1)]);
    assert.equal((await as(alice,'select revision from memories where id=$1',[id]))[0].revision,before.revision,
      're-embedding under a different model must not bump the revision either');

    // A real change still counts as one, or the token stops protecting anything.
    const [corrected]=await as(alice,'select * from correct_memory($1,$2,$3)',[id,before.revision,'Now it says something else.']);
    assert.equal(corrected.revision,before.revision+1,'changing the statement must still bump the revision');
  });

  await t.test('personal_memories returns every personal row and no project row', async () => {
    const r=await as(alice,'select * from personal_memories()');
    assert.equal(r.length,1);
    assert.equal(r[0].statement,'Never use em dashes in anything written for me.');
  });

  await t.test('an agent connection reads settings but cannot change them', async () => {
    await as(alice,'insert into memory_settings(gate) values(0.7)');
    const read=await as(alice,'select gate from memory_settings',[],'agent-1');
    assert.equal(Number(read[0].gate).toFixed(2),'0.70','an agent must be able to read settings');
    // RLS with no matching policy filters the row out rather than raising, so
    // the check is that nothing moved, not that it threw.
    await as(alice,'update memory_settings set gate=0.9',[],'agent-1');
    const after=await as(alice,'select gate from memory_settings');
    assert.equal(Number(after[0].gate).toFixed(2),'0.70','an agent must not change settings');
    await as(alice,'update memory_settings set gate=0.8');
    const owner=await as(alice,'select gate from memory_settings');
    assert.equal(Number(owner[0].gate).toFixed(2),'0.80','the owner still can');
  });

  await t.test('the owner can change every setting, and an agent still cannot change any', async () => {
    // Four columns were granted when the table was created and every column
    // added since was granted select alone, so `capture` has been unwritable
    // since the router shipped. capture_mode is the one that matters: it
    // decides which of the two writers runs, and unsettable means the
    // turn-by-turn router is the writer forever.
    const tunable = ['per_prompt_matches', 'gate', 'scope_boost', 'session_budget_tokens',
      'capture', 'capture_window', 'capture_mode', 'block_size', 'staleness_commits'];
    const writable = (await as(alice,
      `select column_name from information_schema.column_privileges
       where table_name='memory_settings' and grantee='authenticated'
         and privilege_type='UPDATE' order by column_name`)).map(r => r.column_name);
    assert.deepEqual(writable.sort(), [...tunable].sort(),
      'a column nobody can write is not a setting');

    await as(alice, `update memory_settings set capture_mode='session'`);
    assert.equal((await as(alice, 'select capture_mode from memory_settings'))[0].capture_mode, 'session');

    // The grant is per column and the policy is per role, so this is the half
    // that keeps an agent out: it has SELECT on the table and no permissive
    // policy for UPDATE, so the write finds nothing and changes nothing.
    await as(alice, `update memory_settings set capture_mode='turn'`, [], 'agent-1');
    assert.equal((await as(alice, 'select capture_mode from memory_settings'))[0].capture_mode, 'session',
      'an agent must not be able to switch the writer');
    await as(alice, `update memory_settings set capture_mode='turn'`);
  });

  await t.test('a memory has one scope and no task to hang off', async () => {
    // The link is gone, and with it the only way a wrong task guess could move
    // a memory into a project nobody mentioned. A memory is scoped by the
    // project it is saved in and by nothing else.
    const taskId='40000000-0000-4000-8000-000000000001';
    await as(alice,'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      ['50000000-0000-4000-8000-000000000001',taskId,projectA,'Fix the consent page','','',[],'','medium']);
    const columns=await as(alice,
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='memories' and column_name='task_id'`);
    assert.deepEqual(columns,[],'memories.task_id is gone, so nothing can quietly re-derive scope from it');
    const ok=await as(alice,'select * from save_memory($1,$2,$3,$4,$5)',
      ['30000000-0000-4000-8000-0000000000cc',projectA,'Right scope.','','heard']);
    assert.equal(ok[0].project_id,projectA);
    assert.equal(ok[0].band,'heard');
  });

  await t.test('confirming a heard memory promotes it to said', async () => {
    const id='30000000-0000-4000-8000-0000000000dd';
    await as(alice,'select * from save_memory($1,$2,$3,$4,$5)',[id,null,'Picked up in passing.','said it','heard']);
    const [row]=await as(alice,'select id,revision,band from memories where id=$1',[id]);
    assert.equal(row.band,'heard');
    const [promoted]=await as(alice,'select * from confirm_memory($1,$2)',[row.id,row.revision]);
    assert.equal(promoted.band,'said');
  });

  await db.close();
});
