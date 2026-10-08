#!/usr/bin/env node
// Writes the migration that renames project to topic in the database.
//
//   node scripts/generate-topics-rename.mjs path/to/prod-acl.json > supabase/migrations/<version>_topics_everywhere.sql
//
// Generated rather than written by hand because 65 functions, 18 policies and
// 19 columns say project, and a rename that misses one breaks it at run time,
// not when the migration applies. The chain in supabase/migrations is applied
// to PGlite, the catalog is read, and the SQL is built from what is there.
//
// The second input is production's own pg_proc: each function's definition
// and grants. Definitions come from there rather than from PGlite so what is
// recreated is what production runs, and grants because Supabase gives every
// new function to anon by default, so a recreated one has to get exactly its
// old grants back. PGlite is used for the dependency walk and the renames.
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations, migrationFiles} from '../tests/helpers/migrations.mjs';

const acls = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// The management API reads with extensions on the search path, so it prints
// the vector type bare. A migration runs without it.
const plain = args => args.replaceAll('extensions.', '');
const production = f => {
  const row = acls.find(a => a.schema === f.schema && a.name === f.name && plain(a.args) === plain(f.args));
  if (!row) throw new Error(`no production definition for ${f.schema}.${f.name}(${f.args})`);
  return {...row, def: row.def.replace(/(\(|, )(p_\w+) vector\b/g, '$1$2 extensions.vector')};
};

// create_topic already names the pass's own function, so it moves aside first
// and create_project can take the name.
export const toTopic = text => text
  .replace(/\bcreate_topic\b/g, 'create_satchel_topic')
  .replaceAll('PROJECT', 'TOPIC').replaceAll('Projects', 'Topics').replaceAll('Project', 'Topic')
  .replaceAll('projects', 'topics').replaceAll('project', 'topic');

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role supabase_auth_admin; create role service_role;
  create schema auth; create schema storage;
  create table storage.objects(bucket_id text,name text,metadata jsonb,user_metadata jsonb, owner uuid);
  create table auth.users(id uuid primary key);
  create function auth.jwt() returns jsonb language sql stable as
    $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
  create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
  grant usage on schema auth,public to authenticated,anon;`);
// The chain as it stood before this rename, never the rename itself.
await applyMigrations(db, {files: (await migrationFiles()).filter(f => f < '20261009090000')});
const rows = async sql => (await db.query(sql)).rows;
const ident = name => /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`;

const functions = await rows(`select p.oid, n.nspname schema, p.proname name,
    pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.prokind = 'f'
    and (p.proname ilike '%project%' or p.prosrc ilike '%project%' or p.proname = 'create_topic')
  order by 2, 3, 4`);

const policySql = p => `create policy ${ident(p.policyname)} on ${p.schemaname}.${ident(p.tablename)}`
  + ` as ${p.permissive.toLowerCase()} for ${p.cmd.toLowerCase()} to ${p.roles.replace(/[{}]/g, '').split(',').map(ident).join(', ')}`
  + (p.qual ? ` using (${p.qual})` : '') + (p.with_check ? ` with check (${p.with_check})` : '') + ';';
const policies = async () => rows(`select schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
  from pg_policies where schemaname in ('public','storage') order by 1,2,3`);
const triggers = async () => rows(`select t.tgname name, c.relname tbl, n.nspname schema, pg_get_triggerdef(t.oid) def
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname in ('public','storage') order by 3,2,1`);
const views = async () => rows(`select c.relname name, pg_get_viewdef(c.oid) def, coalesce(array_to_string(c.reloptions, ', '), '') options,
    coalesce(c.relacl::text, '') acl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v' order by 1`);

// What dropping the functions takes with it, found by doing it and rolling back.
const before = {policies: await policies(), triggers: await triggers(), views: await views()};
await db.exec('begin');
for (const f of functions) await db.exec(`drop function if exists ${f.schema}.${ident(f.name)}(${f.args}) cascade`);
const after = {policies: await policies(), triggers: await triggers(), views: await views()};
await db.exec('rollback');
const key = p => `${p.schemaname}.${p.tablename}.${p.policyname}`;
const lostPolicies = before.policies.filter(p => !after.policies.some(q => key(q) === key(p)));
const lostTriggers = before.triggers.filter(t => !after.triggers.some(u => u.name === t.name && u.tbl === t.tbl));
const lostViews = before.views.filter(v => !after.views.some(w => w.name === v.name));

const tables = await rows(`select c.relname name from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname ilike '%project%' order by 1`);
const columns = await rows(`select c.relname tbl, a.attname col, c.relkind kind from pg_attribute a
  join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','v') and a.attnum > 0 and not a.attisdropped
    and a.attname ilike '%project%' order by 1,2`);
const constraints = await rows(`select conrelid::regclass::text tbl, conname name from pg_constraint
  where connamespace = 'public'::regnamespace and conname ilike '%project%'
    -- PGlite is newer than production and names NOT NULL constraints; production has none.
    and contype <> 'n' order by 1,2`);
const indexes = await rows(`select c.relname name from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'i' and c.relname ilike '%project%'
    and not exists (select 1 from pg_constraint k where k.conindid = c.oid) order by 1`);

const out = [];
const say = line => out.push(line);
say('begin;');
say('');
say('-- Functions are recreated in name order, so a SQL function may name one that');
say('-- comes later. pg_dump does the same: bodies are checked when they run.');
say('set local check_function_bodies = off;');
say('');
say('-- Project is called topic everywhere, the database included. Generated by');
say('-- scripts/generate-topics-rename.mjs from the migration chain; see that file');
say('-- for how. Tables, columns, constraints, indexes, triggers and policies are');
say('-- renamed in place, so rows, keys and grants on tables are untouched. Every');
say('-- function that names a project is dropped and recreated under its topic name,');
say('-- with production\'s own grants put back, and whatever the drop took with it');
say('-- (policies, triggers, views) is recreated from its definition.');
say('');
say('-- 1. Functions out of the way.');
for (const f of functions) say(`drop function ${f.schema}.${ident(f.name)}(${f.args}) cascade;`);
for (const v of lostViews) say(`drop view if exists public.${ident(v.name)};`);
say('');
say('-- 2. Tables, columns, constraints, indexes, triggers and policies, renamed.');
for (const t of tables) say(`alter table public.${t.name} rename to ${toTopic(t.name)};`);
const renamedTable = name => tables.some(t => t.name === name) ? toTopic(name) : name;
for (const c of columns.filter(c => c.kind === 'r'))
  say(`alter table public.${renamedTable(c.tbl)} rename column ${c.col} to ${toTopic(c.col)};`);
for (const k of constraints) {
  const tbl = renamedTable(k.tbl.replace(/^public\./, ''));
  say(`alter table public.${tbl} rename constraint ${k.name} to ${toTopic(k.name)};`);
}
for (const i of indexes) say(`alter index public.${i.name} rename to ${toTopic(i.name)};`);
for (const t of before.triggers.filter(t => t.name.includes('project') && !lostTriggers.includes(t)))
  say(`alter trigger ${t.name} on ${t.schema}.${renamedTable(t.tbl)} rename to ${toTopic(t.name)};`);
for (const p of before.policies.filter(p => p.policyname.includes('project') && !lostPolicies.includes(p)))
  say(`alter policy ${ident(p.policyname)} on ${p.schemaname}.${renamedTable(p.tablename)} rename to ${ident(toTopic(p.policyname))};`);
for (const c of columns.filter(c => c.kind === 'v' && !lostViews.some(v => v.name === c.tbl)))
  say(`alter view public.${c.tbl} rename column ${c.col} to ${toTopic(c.col)};`);
say('');
say('-- 3. Functions, recreated under their topic names.');
for (const f of functions) { say(toTopic(production(f).def).trim() + ';'); say(''); }
const serviceRole = [];
say('-- 4. Exactly the grants production had, nothing Supabase adds by default.');
for (const f of functions) {
  const sig = `${f.schema}.${ident(toTopic(f.name))}(${toTopic(f.args)})`;
  const prod = production(f);
  say(`revoke all on function ${sig} from public, anon, authenticated;`);
  const grantees = (prod.acl.match(/(?:^|[{,])([a-z_]*)=X/g) ?? []).map(g => g.replace(/^[{,]/, '').replace('=X', ''))
    .filter(g => g !== 'postgres');
  for (const g of grantees.filter(g => g !== 'service_role')) say(`grant execute on function ${sig} to ${g === '' ? 'public' : g};`);
  if (grantees.includes('service_role')) serviceRole.push(sig);
}
// service_role exists on Supabase and not in a bare Postgres; the grant is
// production's own, so it is given only where the role is there to take it.
say(`do $grants$ begin if exists (select 1 from pg_roles where rolname = 'service_role') then`);
for (const sig of serviceRole) say(`  execute 'grant execute on function ${sig.replaceAll("'", "''")} to service_role';`);
say('end if; end $grants$;');
say('');
say('-- 5. What the drop took with it.');
for (const v of lostViews) {
  say(`create view public.${ident(toTopic(v.name))}${v.options ? ` with (${v.options})` : ''} as ${toTopic(v.def).trim().replace(/;$/, '')};`);
}
for (const t of lostTriggers) say(toTopic(t.def) + ';');
for (const p of lostPolicies.filter(p => p.schemaname !== 'storage')) say(toTopic(policySql(p)));
// Storage exists on Supabase and not in a bare Postgres, the same guard the
// migration that first made these used.
const storage = lostPolicies.filter(p => p.schemaname === 'storage');
if (storage.length) {
  say(`do $storage$ begin if to_regclass('storage.objects') is not null then`);
  for (const p of storage) say(`  execute ${"'" + toTopic(policySql(p)).replaceAll("'", "''") + "'"};`);
  say('end if; end $storage$;');
}
say('');
say('commit;');
console.log(out.join('\n'));
console.error(`functions ${functions.length}, tables ${tables.length}, columns ${columns.length}, constraints ${constraints.length},`
  + ` indexes ${indexes.length}, recreated: views ${lostViews.length} triggers ${lostTriggers.length} policies ${lostPolicies.length}`);
