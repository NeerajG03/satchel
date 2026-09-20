import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

const alice='10000000-0000-4000-8000-000000000001';
const bob  ='10000000-0000-4000-8000-000000000002';
const projectA='20000000-0000-4000-8000-00000000000a';

test('slugs are supplied, unique per user, and never silently derived away',async t=>{
  const db=new PGlite();
  const as=async(id,sql,params=[])=>{
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id})]);
      const r=await db.query(sql,params);
      await db.exec('commit');
      return r.rows;
    } catch(e){ await db.exec('rollback'); throw e; }
  };
  await db.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    insert into auth.users values ('${alice}'), ('${bob}');`);
  await applyMigrations(db);

  const newTask=(owner,slug,id,project,title)=>as(owner,
    'select * from create_task_with_slug($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [slug,crypto.randomUUID(),id,project,title,'','',[],'','medium']);

  await as(alice,'select * from create_project($1,$2,$3)',[projectA,'Cardinal Ledger','Payments']);

  await t.test('an existing row is backfilled from its name rather than left without one',async()=>{
    const [row]=await as(alice,'select slug from projects where id=$1',[projectA]);
    assert.equal(row.slug,'cardinal-ledger');
  });

  await t.test('a supplied slug is kept exactly, not re-derived from the title',async()=>{
    const id='40000000-0000-4000-8000-000000000001';
    const [task]=await newTask(alice,'fix-consent-layout',id,projectA,
      'Fix the corner leak where the shell background paints through the paper panel');
    assert.equal(task.slug,'fix-consent-layout');
  });

  await t.test('a slug is unique per user across projects and tasks together',async()=>{
    await assert.rejects(
      newTask(alice,'fix-consent-layout','40000000-0000-4000-8000-000000000002',projectA,'Another'),
      err=>err.code==='23505');
    // and the create rolled back with it, rather than leaving a task behind
    const [{count}]=await as(alice,`select count(*)::int from tasks where id=$1`,
      ['40000000-0000-4000-8000-000000000002']);
    assert.equal(count,0,'a slug collision must roll the create back');
  });

  await t.test('two users may hold the same slug',async()=>{
    await as(bob,'select * from create_project($1,$2,$3)',
      ['20000000-0000-4000-8000-00000000000b','Cardinal Ledger','Bob']);
    const [row]=await as(bob,'select slug from projects where owner_id=$1',[bob]);
    assert.equal(row.slug,'cardinal-ledger','unique per user, not globally');
  });

  await t.test('a malformed slug is refused with something readable',async()=>{
    for(const bad of ['Not A Slug','x'.repeat(41),'trailing-','-leading','under_score',''])
      await assert.rejects(
        newTask(alice,bad,crypto.randomUUID(),projectA,'Bad'),
        /slug|Invalid/i,`"${bad}" should be refused`);
  });

  await t.test('a short name keeps its short slug instead of failing its own check',async()=>{
    // A three character floor rejected "go", "ui" and "qa", which are exactly
    // the slugs a person would pick. Creating a project named Go raised a bare
    // 23514 from inside create_project, which is not something anyone can act
    // on. The floor was the wrong rule, not the wrong implementation.
    const id='20000000-0000-4000-8000-00000000000d';
    await as(alice,'select * from create_project($1,$2,$3)',[id,'Go','A service written in Go']);
    assert.equal((await as(alice,'select slug from projects where id=$1',[id]))[0].slug,'go');
    const [task]=await newTask(alice,'qa',crypto.randomUUID(),projectA,'Quality');
    assert.equal(task.slug,'qa');
  });

  await t.test('a collision suffix after truncation never doubles the hyphen',async()=>{
    // The candidate was built by cutting the base to 36 characters and adding
    // '-' plus a suffix, with no attention to what the 36th character was. A
    // title that truncates onto a hyphen produced "...-shell--2", which does
    // not match the slug pattern and failed the check constraint.
    const title='Fix the corner leak where the shell background paints through';
    const first=crypto.randomUUID(), second=crypto.randomUUID();
    await as(alice,'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [crypto.randomUUID(),first,projectA,title,'','',[],'','medium']);
    await as(alice,'select * from create_task($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [crypto.randomUUID(),second,projectA,title,'','',[],'','medium']);
    const [row]=await as(alice,'select slug from tasks where id=$1',[second]);
    assert.doesNotMatch(row.slug,/--/,'a doubled hyphen fails the slug check');
    assert.match(row.slug,/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  await t.test('a write path that supplies none still cannot create a slugless row',async()=>{
    // The web app and older clients go through create_project, which has no
    // slug argument. The row still ends up with one.
    const id='20000000-0000-4000-8000-00000000000c';
    await as(alice,'select * from create_project($1,$2,$3)',[id,'Cardinal Ledger','Same name again']);
    const [row]=await as(alice,'select slug from projects where id=$1',[id]);
    assert.match(row.slug,/^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.notEqual(row.slug,'cardinal-ledger','a collision takes a suffix rather than failing');
  });

  await t.test('renaming a slug is owner-scoped',async()=>{
    await as(alice,'select set_slug($1,$2,$3)',['project',projectA,'cardinal']);
    assert.equal((await as(alice,'select slug from projects where id=$1',[projectA]))[0].slug,'cardinal');
    await assert.rejects(as(bob,'select set_slug($1,$2,$3)',['project',projectA,'stolen']),
      err=>err.code==='P0002','another owner cannot rename it');
  });

  await t.test('renaming obeys the same one-namespace rule as creating',async()=>{
    // Creating picked a candidate unique across projects and tasks together,
    // but renaming only had the per-table unique index, so a task could be
    // renamed onto a project's slug. Whether the rule held depended on which
    // path made the row, and both create wrappers route through set_slug.
    await assert.rejects(
      as(alice,'select set_slug($1,$2,$3)',['task','40000000-0000-4000-8000-000000000001','cardinal']),
      err=>err.code==='23505','a task may not take a project\'s slug');
    // Renaming to the slug it already has stays a no-op rather than a conflict.
    assert.equal((await as(alice,'select set_slug($1,$2,$3) as s',['project',projectA,'cardinal']))[0].s,'cardinal');
  });

  await t.test('the planning view exposes the slug, so a list can name a task',async()=>{
    const [row]=await as(alice,'select slug from task_planning where id=$1',
      ['40000000-0000-4000-8000-000000000001']);
    assert.equal(row.slug,'fix-consent-layout');
  });

  await db.close();
});
