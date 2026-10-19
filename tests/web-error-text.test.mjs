import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';
import {Sentence,errorMessage,needsSessionCheck,raisedText,raisedPatterns,sessionGuards,personSentences,
  constraintText,LOAD_FAILED} from '../src/errorText.mjs';

const SIGN_IN=/sign in again/i;

// Routines whose `raise exception '%', problem` passes on a sentence that
// private.schedule_problem wrote for the person. Anything else raising a bare
// '%' would reach the page unmapped, so it has to be added here on purpose.
const PASS_THROUGH=new Set(['public.set_consolidation_schedule','public.enable_consolidation']);

// Every raise in the latest definition of every routine, read from the
// database after all migrations ran, so a raise that a later migration
// replaced does not count and one it added does.
async function latestRaises() {
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema auth, public to anon, authenticated;`);
  await applyMigrations(db);
  const {rows}=await db.query(`select n.nspname||'.'||p.proname as name,p.prosrc as src from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')`);
  await db.close();
  const raises=[];
  for(const {name,src} of rows)
    for(const m of src.matchAll(/raise exception '((?:[^']|'')*)'([^;]*);/g)){
      const code=/errcode\s*=\s*'([^']+)'/.exec(m[2])?.[1]??'P0001';
      raises.push({routine:name,message:m[1].replaceAll("''","'"),code});
    }
  return {raises,routines:new Set(rows.map(r=>r.name))};
}

const covered=message=>sessionGuards.has(message)||Boolean(raisedText[message])
  ||raisedPatterns.some(([pattern])=>pattern.test(message.replaceAll('%','2')));

test('every refusal a routine can raise has a sentence for the person',async()=>{
  const {raises}=await latestRaises();
  assert.ok(raises.length>50,'the scan found the raises');
  const missing=[];
  for(const r of raises){
    if(r.message==='%'){
      if(!PASS_THROUGH.has(r.routine))missing.push(`${r.routine} raises a bare '%' (${r.code})`);
      continue;
    }
    if(!covered(r.message))missing.push(`${r.routine}: '${r.message}' (${r.code})`);
  }
  assert.deepEqual(missing,[],'Add a line to raisedText in src/errorText.mjs for each of these');
});

test('every routine the web app calls exists',async()=>{
  const {routines}=await latestRaises();
  const names=new Set();
  const walk=async dir=>{
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const path=`${dir}/${entry.name}`;
      if(entry.isDirectory())await walk(path);
      else if(/\.(ts|tsx|mjs)$/.test(entry.name))
        for(const m of (await readFile(path,'utf8')).matchAll(/rpc(?:<[^>]*>)?\(\s*'([a-z_0-9]+)'/g))names.add(m[1]);
    }
  };
  await walk(new URL('../src',import.meta.url).pathname);
  assert.ok(names.size>30,'the scan found the calls');
  const gone=[...names].filter(n=>!routines.has('public.'+n));
  assert.deepEqual(gone,[]);
});

test('no refusal sentence tells a person to sign in again',()=>{
  for(const [message,text] of Object.entries(raisedText))assert.doesNotMatch(text,SIGN_IN,message);
  for(const [,text] of raisedPatterns.filter(([p])=>!p.test('JWT expired')))assert.doesNotMatch(text,SIGN_IN);
  for(const text of Object.values(constraintText))assert.doesNotMatch(text,SIGN_IN);
});

test('the storage trigger refusing a delete is not a sign-in problem',()=>{
  const error={code:'42501',message:'Direct deletion from storage tables is not allowed. Use the Storage API instead.',hint:'',details:null};
  assert.equal(needsSessionCheck(error),false);
  for(const op of ['save','action','load']){
    const text=errorMessage(error,op);
    assert.doesNotMatch(text,SIGN_IN);
    assert.match(text,/nothing was deleted/);
  }
});

test('a 42501 nobody listed says it was refused, and does not guess',()=>{
  const text=errorMessage({code:'42501',message:'Something new'},'action');
  assert.doesNotMatch(text,SIGN_IN);
  assert.match(text,/refused/);
  assert.match(text,/nothing was changed/);
});

test('our own refusals name what went wrong',()=>{
  assert.match(errorMessage({code:'42501',message:'Topic write unavailable'},'action'),/topics/);
  assert.match(errorMessage({code:'42501',message:'Repository link unavailable'},'action'),/Nothing was linked/);
  assert.match(errorMessage({code:'42501',message:'Task upload unavailable'},'action'),/file/);
  assert.match(errorMessage({code:'42501',message:'Invalid topic selection'},'action'),/topics you picked/);
  assert.match(errorMessage({code:'P0002',message:'Topic not found'},'action'),/topic is already gone/);
  assert.match(errorMessage({code:'P0002',message:'Task unavailable'},'save'),/task/);
  assert.match(errorMessage({code:'PT409',message:'Topic revision conflict'},'action'),/changed while you were looking/);
  assert.match(errorMessage({code:'23505',message:'That slug is already in use'}),/short name/);
  assert.match(errorMessage({code:'23514',message:'Task parent cycle'}),/loop|parent/);
});

test('a session guard says sign in again only when the auth client has no session',()=>{
  for(const message of [...sessionGuards,'permission denied for function delete_topic']){
    const error={code:'42501',message};
    assert.equal(needsSessionCheck(error),true,message);
    assert.match(errorMessage(error,'action',false),SIGN_IN,message);
    assert.doesNotMatch(errorMessage(error,'action',true),SIGN_IN,message);
    assert.doesNotMatch(errorMessage(error,'action',undefined),SIGN_IN,message);
  }
});

test('an expired token is the session, with no check needed',()=>{
  for(const error of [{code:'PGRST301',message:'JWSError'},{code:'PGRST303',message:'JWT expired'},{code:'',message:'JWT expired'},
    {__isAuthError:true,name:'AuthSessionMissingError',message:'Auth session missing!',status:400},
    {__isAuthError:true,name:'AuthApiError',code:'session_not_found',status:403,message:'x'},
    {__isStorageError:true,name:'StorageApiError',status:400,statusCode:'400',code:'InvalidJWT',message:'exp claim timestamp check failed'}])
    assert.match(errorMessage(error,'action'),SIGN_IN,JSON.stringify(error));
});

test('storage failures say what happened to the file',()=>{
  const storage=(status,message,code)=>({__isStorageError:true,name:'StorageApiError',status,statusCode:String(status),code,message});
  assert.match(errorMessage(storage(403,'new row violates row-level security policy'),'action'),/File storage refused/);
  assert.match(errorMessage(storage(404,'Object not found'),'action'),/no longer in storage/);
  assert.match(errorMessage(storage(409,'The resource already exists','Duplicate'),'action'),/already stored/);
  assert.match(errorMessage(storage(413,'The object exceeded the maximum allowed size'),'action'),/6 MB/);
});

test('constraint violations name the field, and never quote the row',()=>{
  const error={code:'23514',message:'new row for relation "tasks" violates check constraint "tasks_title_check"',details:'Failing row contains (secret)'};
  const text=errorMessage(error);
  assert.match(text,/task title/);
  assert.doesNotMatch(text,/secret|constraint|relation/);
  assert.match(errorMessage({code:'23505',message:'duplicate key value violates unique constraint "memories_scope_name"'}),/handle/);
  assert.match(errorMessage({code:'23505',message:'duplicate key value violates unique constraint "topics_owner_slug"'}),/short name/);
});

test('no mapped text quotes the database',()=>{
  const raw='permission denied for table memories; SQLSTATE 42501';
  for(const code of ['42501','P0002','PT409','23514','23505','22P02','XX000','']){
    for(const op of ['load','save','action'])assert.doesNotMatch(errorMessage({code,message:raw},op,true),/SQLSTATE|memories;/);
  }
});

test('sentences we wrote pass through, and nothing else does',()=>{
  assert.equal(errorMessage(new Sentence('That memory is not live any more.')),'That memory is not live any more.');
  assert.equal(errorMessage(new Error('Files are limited to 6 MB in this first slice.')),'Files are limited to 6 MB in this first slice.');
  assert.equal(errorMessage({code:'22023',message:'Choose at least one day of the week.'}),'Choose at least one day of the week.');
  assert.ok(personSentences.test('That time zone is not recognised.'));
  assert.doesNotMatch(errorMessage(new Error('TypeError: Failed to fetch'),'action'),/TypeError/);
  assert.equal(errorMessage(new Error('Failed to fetch'),'load'),LOAD_FAILED);
});

test('timeouts and conflicts keep the draft wording only for a form',()=>{
  assert.match(errorMessage({code:'SATCHEL_TIMEOUT'},'save'),/draft/);
  assert.doesNotMatch(errorMessage({code:'SATCHEL_TIMEOUT'},'action'),/draft/);
  assert.doesNotMatch(errorMessage({code:'PT409',message:''},'action'),/draft/);
});
