import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';
import {Sentence,errorMessage,needsSessionCheck,raisedText,raisedPatterns,sessionGuards,personSentences,
  constraintText,LOAD_FAILED,reasonText,reasonOf,SESSION_REASON,APP_TOKEN_REASON,PERSON_REASON} from '../src/errorText.mjs';

const SIGN_IN=/sign in again/i;

// Routines whose `raise exception '%', problem` passes on a sentence that
// private.schedule_problem wrote for the person, with hint satchel:person.
// Anything else raising a bare '%' would reach the page unmapped, so it has to
// be added here on purpose.
const PASS_THROUGH=new Set(['public.set_consolidation_schedule','public.enable_consolidation']);
// The last migration before every raise carried a hint. The sentences raised
// as of this file are what an older database still sends.
const BEFORE_HINTS='20261019110000_one_save_one_transaction.sql';

async function database(through) {
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth, public to anon, authenticated;`);
  await applyMigrations(db,{through});
  return db;
}

// Every raise in the latest definition of every routine, read from the
// database after the migrations ran, so a raise that a later migration
// replaced does not count and one it added does.
async function latestRaises(through) {
  const db=await database(through);
  const {rows}=await db.query(`select n.nspname||'.'||p.proname as name,p.prosrc as src from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')`);
  await db.close();
  const raises=[],unread=[];
  for(const {name,src} of rows)
    for(const statement of raiseStatements(src)){
      if(/^raise\s*;$|^raise\s+(debug|log|info|notice|warning)\b/i.test(statement))continue;
      const m=/^raise\s+exception\s+'((?:[^']|'')*)'([^;]*);$/i.exec(statement);
      if(!m){unread.push(`${name}: ${statement}`);continue;}
      const code=/errcode\s*=\s*'([^']+)'/i.exec(m[2])?.[1]??'P0001';
      const hint=/hint\s*=\s*'([^']*)'/i.exec(m[2])?.[1]??'';
      raises.push({routine:name,message:m[1].replaceAll("''","'"),code,hint});
    }
  return {raises,unread,routines:new Set(rows.map(r=>r.name))};
}

// Every raise statement in a body, in any case or form, up to the semicolon
// that ends it outside a string. Comments are skipped.
function raiseStatements(src) {
  const out=[];
  let i=0,start=-1;
  while(i<src.length){
    if(src.startsWith('--',i)){i=src.indexOf('\n',i);if(i<0)break;continue;}
    if(src.startsWith('/*',i)){i=src.indexOf('*/',i);if(i<0)break;i+=2;continue;}
    if(src[i]==="'"){
      i++;
      while(i<src.length&&!(src[i]==="'"&&src[i+1]!=="'"))i+=src[i]==="'"?2:1;
      i++;continue;
    }
    if(start<0&&/^raise\b/i.test(src.slice(i,i+6))&&!/\w/.test(src[i-1]??'')){start=i;i+=5;continue;}
    if(start>=0&&src[i]===';'){out.push(src.slice(start,i+1).replace(/\s+/g,' '));start=-1;}
    i++;
  }
  return out;
}

test('every refusal a routine can raise says why, and the reason has a sentence',async()=>{
  const {raises,unread}=await latestRaises();
  assert.ok(raises.length>50,'the scan found the raises');
  assert.deepEqual(unread,[],"Write each raise as raise exception '...' using errcode = '...', hint = 'satchel:...'");
  const missing=[];
  for(const r of raises){
    const at=`${r.routine}: '${r.message}' (${r.code})`;
    if(!r.hint.startsWith('satchel:')){missing.push(`${at} has no satchel: hint`);continue;}
    const reason=r.hint.slice('satchel:'.length);
    if(reason===PERSON_REASON){
      if(!PASS_THROUGH.has(r.routine)||r.message!=='%')missing.push(`${at} passes its message to the person`);
      continue;
    }
    if(r.message==='%')missing.push(`${at} raises a bare '%' without satchel:person`);
    if(reason!==SESSION_REASON&&reason!==APP_TOKEN_REASON&&!Object.hasOwn(reasonText,reason))
      missing.push(`${at} gives reason '${reason}', which has no line in reasonText`);
  }
  assert.deepEqual(missing,[],'Give each raise a hint, and each reason a line in reasonText in src/errorText.mjs');
});

test('a database from before the hints still gets a sentence for every refusal',async()=>{
  // Only routines that still exist: one dropped since cannot raise anything.
  const {routines:live}=await latestRaises();
  const raises=(await latestRaises(BEFORE_HINTS)).raises.filter(r=>live.has(r.routine));
  assert.ok(raises.length>30,'the scan found the raises');
  const covered=message=>sessionGuards.has(message)||Boolean(raisedText[message])
    ||raisedPatterns.some(([pattern])=>pattern.test(message.replaceAll('%','2')));
  const missing=raises.filter(r=>r.message==='%'?!PASS_THROUGH.has(r.routine):!covered(r.message))
    .map(r=>`${r.routine}: '${r.message}' (${r.code})`);
  assert.deepEqual(missing,[]);
});

test('a guard says which it was: no session, or an app token',async()=>{
  const db=await database();
  const owner=crypto.randomUUID();
  async function hintFor(claims,sql) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
      await db.query(sql);
      return 'no error';
    } catch(error) { return error.hint; } finally { await db.exec('rollback'); }
  }
  for(const sql of ["select revoke_agent('x')","select recent_documents()",
    "select authorize_agent_v4('x','x',false,false,'{}'::uuid[],false)"]){
    assert.equal(await hintFor({},sql),'satchel:session',sql);
    assert.equal(await hintFor({sub:owner,client_id:'x'},sql),'satchel:app_token',sql);
  }
  assert.equal(await hintFor({},"select set_slug('topic',gen_random_uuid(),'a-b')"),'satchel:session');
  await db.close();
});

test('the hint decides, whatever the sentence says',()=>{
  const reworded=(code,hint)=>({code,hint,message:'Some sentence that was reworded'});
  assert.match(errorMessage(reworded('42501','satchel:refused:topic_write'),'action'),/topics/);
  assert.match(errorMessage(reworded('P0002','satchel:gone:topic'),'action'),/topic is already gone/);
  assert.match(errorMessage(reworded('PT409','satchel:conflict:memory'),'save'),/memory/);
  assert.match(errorMessage(reworded('23514','satchel:invalid:topic_has_work')),/only you can merge/);
  // A guard's old sentence with the new hint is not a session check.
  const app={code:'42501',hint:'satchel:app_token',message:'Companion sign-in required'};
  assert.equal(needsSessionCheck(app),false);
  assert.doesNotMatch(errorMessage(app,'action'),SIGN_IN);
  const session={code:'42501',hint:'satchel:session',message:'Some sentence that was reworded'};
  assert.equal(needsSessionCheck(session),true);
  assert.match(errorMessage(session,'action',false),SIGN_IN);
  assert.doesNotMatch(errorMessage(session,'action',true),SIGN_IN);
  assert.equal(errorMessage({code:'22023',hint:'satchel:person',message:'Choose one time.'}),'Choose one time.');
  assert.equal(reasonOf({hint:'not ours'}),'');
  const raw='permission denied for table memories';
  assert.notEqual(errorMessage({code:'22023',hint:'satchel:person',message:raw}),raw);
});

test('the scan sees a raise in any form',()=>{
  const forms=raiseStatements(`begin
    RAISE EXCEPTION 'Topic not found' USING ERRCODE = 'P0002';
    raise exception using message = 'x';
    raise sqlstate 'P0001';
    raise 'bare';
    -- raise exception 'in a comment';
    raise notice 'skip me; please';
    perform 'raise exception ''in a string''';
    raise;
  end`);
  assert.deepEqual(forms,["RAISE EXCEPTION 'Topic not found' USING ERRCODE = 'P0002';","raise exception using message = 'x';",
    "raise sqlstate 'P0001';","raise 'bare';","raise notice 'skip me; please';",'raise;']);
});

test('a reason from a newer database falls back to the sentence and the code',()=>{
  assert.match(errorMessage({code:'P0002',hint:'satchel:gone:something_new',message:'Topic not found'},'action'),/topic is already gone/);
  assert.match(errorMessage({code:'42501',hint:'satchel:refused:something_new',message:'New'},'action'),/refused/);
  assert.doesNotMatch(errorMessage({code:'42501',hint:'satchel:toString',message:'New'},'action'),/function/);
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
  assert.ok(names.size>20,'the scan found the calls');
  const gone=[...names].filter(n=>!routines.has('public.'+n));
  assert.deepEqual(gone,[]);
});

test('no refusal sentence tells a person to sign in again',()=>{
  for(const [reason,text] of Object.entries(reasonText))assert.doesNotMatch(text,SIGN_IN,reason);
  for(const [,text] of raisedPatterns.filter(([p])=>!p.test('JWT expired')))assert.doesNotMatch(text,SIGN_IN);
  for(const text of Object.values(constraintText))assert.doesNotMatch(text,SIGN_IN);
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
  assert.match(errorMessage({code:'42501',message:'Invalid topic selection'},'action'),/topics you picked/);
  assert.match(errorMessage({code:'P0002',message:'Topic not found'},'action'),/topic is already gone/);
  assert.match(errorMessage({code:'PT409',message:'Topic revision conflict'},'action'),/changed while you were looking/);
  assert.match(errorMessage({code:'23505',message:'That slug is already in use'}),/short name/);
  assert.match(errorMessage({code:'23514',message:'Topic has work only its owner may move'}),/only you can merge/);
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
    {__isAuthError:true,name:'AuthApiError',code:'session_not_found',status:403,message:'x'}])
    assert.match(errorMessage(error,'action'),SIGN_IN,JSON.stringify(error));
});

test('constraint violations name the field, and never quote the row',()=>{
  const error={code:'23514',message:'new row for relation "topics" violates check constraint "topics_name_check"',details:'Failing row contains (secret)'};
  const text=errorMessage(error);
  assert.match(text,/topic name/);
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
