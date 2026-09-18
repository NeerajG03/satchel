import {createClient} from '@supabase/supabase-js';
import {SUPABASE_URL} from './http-handler.mjs';

const sessionPattern=/^[A-Za-z0-9_-]{16,200}$/;
const repositoryPattern=/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const maximumHintBytes=1024;
const hintFields=new Set(['session_key','provider','repository']);

export function parseRepositoryHint(body) {
  let value=body;
  if(Buffer.isBuffer(value))value=value.toString('utf8');
  if(typeof value==='string') {
    if(Buffer.byteLength(value,'utf8')>maximumHintBytes)throw Error('Invalid hint');
    value=JSON.parse(value);
  }
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid hint');
  // Vercel normally supplies parsed JSON, so Content-Length and the raw-string
  // branch are not sufficient size controls. Reject oversized or expanded
  // objects here as well, and keep the anonymous bridge to its three intended
  // fields instead of accepting arbitrary attacker-controlled baggage.
  let serialized;
  try {serialized=JSON.stringify(value);}
  catch {throw Error('Invalid hint');}
  if(Buffer.byteLength(serialized,'utf8')>maximumHintBytes
    ||Object.keys(value).some(key=>!hintFields.has(key)))throw Error('Invalid hint');
  const session_key=value.session_key;
  const provider=typeof value.provider==='string'?value.provider.trim().toLowerCase():'';
  const repository=typeof value.repository==='string'?value.repository.trim().toLowerCase():'';
  if(typeof session_key!=='string'||!sessionPattern.test(session_key)
    ||provider!=='github'||repository.length>201||!repositoryPattern.test(repository))throw Error('Invalid hint');
  return {session_key,provider,repository};
}

export async function handleRepositoryHint(req,res,makeClient=createClient) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});return res.end();}
  if(Number(req.headers['content-length']??0)>maximumHintBytes){res.writeHead(413);return res.end();}
  let hint;
  try {hint=parseRepositoryHint(req.body);}
  catch {res.writeHead(400);return res.end();}
  const key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if(!key){res.writeHead(503);return res.end();}
  const db=makeClient(SUPABASE_URL,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  try {
    const {error}=await db.rpc('stage_agent_repository_hint',{
      p_session_key:hint.session_key,p_provider:hint.provider,p_repository:hint.repository,
    }).abortSignal(AbortSignal.timeout(3000));
    if(error)throw error;
  }catch{res.writeHead(503);return res.end();}
  res.writeHead(204);return res.end();
}
