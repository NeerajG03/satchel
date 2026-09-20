import {createRemoteJWKSet,jwtVerify} from 'jose';
import {createClient} from '@supabase/supabase-js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createMemoryServer} from './mcp-server.mjs';
import {memoryService} from './memory-service.mjs';
import {createEmbedder} from './embedding.mjs';
import {createRouter} from './router.mjs';
import {taskService} from './task-service.mjs';

export const RESOURCE='https://satchel-pi.vercel.app/api/mcp';
export const SUPABASE_URL='https://prpgcrwteepcunizdcut.supabase.co';
const issuer=SUPABASE_URL+'/auth/v1';
const keys=createRemoteJWKSet(new URL(issuer+'/.well-known/jwks.json'));
export const metadata={resource:RESOURCE,authorization_servers:[issuer],scopes_supported:['openid'],resource_name:'Satchel'};
export async function verifyAgentToken(token,verificationKeys=keys) {
  const {payload}=await jwtVerify(token,verificationKeys,{issuer,audience:RESOURCE,algorithms:['ES256','RS256'],requiredClaims:['exp','sub','client_id','satchel_grant_id']});
  if (typeof payload.client_id!=='string'||typeof payload.satchel_grant_id!=='string') throw Error('Missing grant');
  return payload;
}
// Built once per process rather than per request. A missing or misconfigured
// embedder is not fatal: saves still work and retrieval reports itself
// unavailable, which is the same degradation as the service being down.
let embedder=null;
try { embedder=createEmbedder(); }
catch { /* retrieve_memory will report itself unavailable */ }
// Without a key the router is simply absent and capture does not happen, which
// is the behaviour Satchel had before automatic capture existed.
let router=null;
try { router=process.env.SATCHEL_ROUTER_KEY??process.env.GEMINI_API_KEY??process.env.OPENROUTER_API_KEY?createRouter():null; }
catch { router=null; }

export async function handleMcp(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id');
  res.setHeader('Access-Control-Expose-Headers','WWW-Authenticate');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  if(req.method!=='POST'){res.writeHead(405,{Allow:'POST, OPTIONS'});return res.end();}
  const token=req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  try {if(!token)throw Error('Missing token');await verifyAgentToken(token);}
  catch {res.writeHead(401,{'WWW-Authenticate':`Bearer resource_metadata="https://satchel-pi.vercel.app/.well-known/oauth-protected-resource", scope="openid"`});return res.end('Authentication required');}
  const key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if(!key){res.writeHead(503);return res.end('Server configuration unavailable');}
  const db=createClient(SUPABASE_URL,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:`Bearer ${token}`}}});
  const service=memoryService(db,embedder,router);
  service.tasks=taskService(db,service.status);
  try {
    if(!await service.status()){res.writeHead(403);return res.end('Connection revoked or unavailable');}
  }catch{res.writeHead(503);return res.end('Unable to verify connection');}
  const server=createMemoryServer(service);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void transport.close();void server.close();});
  try {
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  }catch{
    if(!res.headersSent)res.writeHead(500);
    res.end();
  }
}
