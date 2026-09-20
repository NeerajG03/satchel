import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';

test('security posture keeps RLS and routine privileges closed by default',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role supabase_auth_admin;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create table storage.objects(bucket_id text,name text,metadata jsonb,user_metadata jsonb);
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as
        $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;
    `);
    await applyMigrations(db);

    const withoutRls=(await db.query(`
      select c.relname
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
      order by c.relname
    `)).rows.map(row=>row.relname);
    assert.deepEqual(withoutRls,[]);

    const anonExecutable=(await db.query(`
      select p.oid::regprocedure::text signature
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and has_function_privilege('anon',p.oid,'execute')
      order by signature
    `)).rows.map(row=>row.signature);
    assert.deepEqual(anonExecutable,['stage_agent_repository_hint(text,text,text)']);

    const unsafeDefiners=(await db.query(`
      select p.oid::regprocedure::text signature
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and p.prosecdef
        and not exists (
          select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) setting
          where setting like 'search_path=%'
        )
      order by signature
    `)).rows.map(row=>row.signature);
    assert.deepEqual(unsafeDefiners,[]);

    const [{allowed:tokenHook}]= (await db.query(
      `select has_function_privilege('authenticated','public.satchel_access_token_hook(jsonb)','execute') allowed`,
    )).rows;
    const [{allowed:cleanup}]= (await db.query(
      `select has_function_privilege('authenticated','public.cleanup_task_file(uuid,uuid)','execute') allowed`,
    )).rows;
    assert.equal(tokenHook,false);
    assert.equal(cleanup,false);
  }finally {await db.close();}
});
