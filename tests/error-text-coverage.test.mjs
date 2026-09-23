import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {applyMigrations} from './helpers/migrations.mjs';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {errorText,raisedText,raisedPatterns,GENERIC} from '../server/error-text.mjs';

// The database routines each tool reaches. A new tool must be added here, and
// the first test below fails until it is, because a tool nobody listed is a
// tool whose refusals nobody checked.
const TOOL_ROUTINES={
  list_projects:[],memory_index:['list_memories'],retrieve_memory:['search_memories'],read_memory:['read_memory'],
  upsert_project:['upsert_project_with_slug'],
  select_project:['select_agent_project','select_agent_repository','list_memories'],
  save_memory:['save_memory'],correct_memory:['correct_memory'],confirm_memory:['confirm_memory'],forget_memory:['end_memory'],
  list_tasks:[],read_task:[],create_task:['create_task_with_slug'],
  edit_task:['update_task','transition_task','set_task_parent','add_task_dependency','remove_task_dependency'],
  record_task_update:['add_task_comment','record_task_progress','record_task_handoff'],
  add_task_resource:['add_task_resource'],
};

// The line a refusal falls back to when nobody wrote one for it.
const unlisted=text=>text===GENERIC||/breaks (the rule|a Satchel rule)/.test(text);

async function reachable() {
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema auth, public to anon, authenticated;`);
  await applyMigrations(db);
  const {rows:procs}=await db.query(`select n.nspname||'.'||p.proname as name,p.prosrc as src from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')`);
  const source=new Map();
  for(const p of procs)source.set(p.name,(source.get(p.name)??'')+'\n'+p.src);
  const {rows:triggers}=await db.query(`select c.relname as t,p.proname as f from pg_trigger g
    join pg_class c on c.oid=g.tgrelid join pg_proc p on p.oid=g.tgfoid where not g.tgisinternal`);
  // Every check, unique and foreign key constraint, and every unique index
  // that is not already a constraint's.
  const {rows:constraints}=await db.query(`
    select c.relname as t,k.conname as name,k.contype as type from pg_constraint k
      join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and k.contype in ('c','u','f','p')
    union all
    select c.relname,i.relname,'i' from pg_index x join pg_class i on i.oid=x.indexrelid
      join pg_class c on c.oid=x.indrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and x.indisunique
        and not exists(select 1 from pg_constraint k where k.conindid=i.oid)`);
  await db.close();
  const seen=new Set(),tables=new Set(),raises=new Map();
  const walk=name=>{
    if(seen.has(name))return;seen.add(name);
    const body=source.get(name);if(!body)return;
    for(const m of body.matchAll(/raise exception '([^']*)'[^;]*errcode\s*=\s*'([^']+)'/g))raises.set(m[1],{code:m[2],routine:name});
    for(const m of body.matchAll(/(?:insert into|update|delete from)\s+public\.([a-z_]+)/g)){
      tables.add(m[1]);
      for(const t of triggers.filter(t=>t.t===m[1]))walk('public.'+t.f);
    }
    for(const m of body.matchAll(/(public|private)\.([a-z_]+)\s*\(/g))walk(`${m[1]}.${m[2]}`);
  };
  for(const roots of Object.values(TOOL_ROUTINES))for(const r of roots){
    assert.ok(source.has('public.'+r),`${r} is not a routine any more; update TOOL_ROUTINES`);
    walk('public.'+r);
  }
  return {raises,constraints:constraints.filter(c=>tables.has(c.t))};
}

test('every tool is listed with the routines it reaches',async()=>{
  const service={status:async()=>({}),tasks:{}};
  const server=createMemoryServer(service);const client=new Client({name:'test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
  try {
    const tools=(await client.listTools()).tools.map(t=>t.name).sort();
    assert.deepEqual(tools,Object.keys(TOOL_ROUTINES).sort());
  } finally { await client.close();await server.close(); }
});

test('every refusal a tool can reach reads as something the agent can act on',async t=>{
  const {raises,constraints}=await reachable();
  assert.ok(raises.size>20&&constraints.length>50,'the walk found the routines, so an empty result means nothing');

  await t.test('every sentence a routine raises has agent-facing text',()=>{
    // A routine's own sentence would pass through readable anyway, so readable
    // is not the test: each one needs an entry written for the agent. A %
    // placeholder is filled in by the routine, so a number stands in for it.
    const missing=[...raises].filter(([message])=>!raisedText[message]
      &&!raisedPatterns.some(([pattern])=>pattern.test(message.replaceAll('%','2'))))
      .map(([message,{routine}])=>`${routine}: ${message}`);
    assert.deepEqual(missing,[],'add these to raisedText in server/error-text.mjs');
  });

  await t.test('every constraint on a table a tool writes has agent-facing text',()=>{
    const message=({t,name,type})=>type==='f'
      ?{code:'23503',message:`insert or update on table "${t}" violates foreign key constraint "${name}"`}
      :type==='c'
        ?{code:'23514',message:`new row for relation "${t}" violates check constraint "${name}"`}
        :{code:'23505',message:`duplicate key value violates unique constraint "${name}"`};
    const missing=constraints.filter(c=>unlisted(errorText(message(c)))).map(c=>`${c.t}.${c.name}`);
    assert.deepEqual(missing,[],'add these to constraintText, or internalConstraints if only Satchel sets the value');
  });

  await t.test('every sentence a service throws has agent-facing text',async()=>{
    // The services check grants before any query, and a bare code there used
    // to read as "access denied" whichever grant was missing.
    const files=['mcp-server.mjs','memory-service.mjs','task-service.mjs'];
    const thrown=[];
    for(const file of files){
      const code=await readFile(new URL(`../server/${file}`,import.meta.url),'utf8');
      for(const m of code.matchAll(/throw \{code:'([^']+)'(,message:([^}]+))?\}/g)){
        const messages=m[3]?[...m[3].matchAll(/'([^']+)'/g)].map(x=>x[1]):[];
        // A code with one meaning already has its own sentence and needs no message.
        if(!messages.length&&!['PT400','PT404','PT300'].includes(m[1]))thrown.push(`${file}: ${m[0]} has no message`);
        for(const message of messages)if(!raisedText[message])thrown.push(`${file}: ${message}`);
      }
    }
    assert.deepEqual(thrown,[],'give each throw a message listed in raisedText');
  });

  await t.test('the failing row is never repeated back',()=>{
    const text=errorText({code:'23514',message:'new row for relation "tasks" violates check constraint "tasks_slug_check"',
      details:'Failing row contains (a private title)',hint:'a private hint'});
    assert.doesNotMatch(text,/private/);
  });
});

test('every pattern and URL rule in a tool schema says the rule in words',async()=>{
  // zod's default for a failed regex is the regex itself, which is what an
  // agent read for a bad slug. A rule without a message is a rule the agent
  // has to reverse-engineer.
  const code=await readFile(new URL('../server/mcp-server.mjs',import.meta.url),'utf8');
  const bare=[...code.matchAll(/\.regex\((\/(?:\\.|[^/])+\/[a-z]*)\)/g)].map(m=>m[1]);
  assert.deepEqual(bare,[],'give each .regex() a message');
  const urls=[...code.matchAll(/z\.url\(\{([^}]*)\}\)/g)].filter(m=>!/error\s*:/.test(m[1]));
  assert.deepEqual(urls.map(m=>m[0]),[],'give each z.url() an error');
});
