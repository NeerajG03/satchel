import {createClient} from '@supabase/supabase-js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createMemoryServer} from './mcp-server.mjs';
import {memoryService} from './memory-service.mjs';
import {createEmbedder} from './embedding.mjs';
import {createRouter} from './router.mjs';
import {flush} from './tracing.mjs';
import {taskService} from './task-service.mjs';
// Imported, not re-exported straight through: `export ... from` creates no
// local binding, so verifyAgentToken below lost RESOURCE and threw a
// ReferenceError on every token check. tests/mcp.test.mjs caught it.
import {RESOURCE,SUPABASE_URL,metadata} from './identity.mjs';
// Token verification moved out for the same reason the constants did: the hook
// endpoints check a token and must not load the model stack to do it.
import {verifyAgentToken,CHALLENGE} from './agent-token.mjs';

// Re-exported so existing importers keep working, but the definitions live in
// identity.mjs, which imports nothing. Anything that needs only these should
// import them from there instead: reaching them through this file drags in the
// MCP server, the Supabase client, the embedder and the router.
export {RESOURCE,SUPABASE_URL,metadata};
export {verifyAgentToken};
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
  let claims;
  try {if(!token)throw Error('Missing token');claims=await verifyAgentToken(token);}
  catch {res.writeHead(401,{'WWW-Authenticate':CHALLENGE});return res.end('Authentication required');}
  const key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if(!key){res.writeHead(503);return res.end('Server configuration unavailable');}
  const db=createClient(SUPABASE_URL,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:`Bearer ${token}`}}});
  const service=memoryService(db,embedder,router);
  service.tasks=taskService(db,service.status);
  try {
    if(!await service.status()){res.writeHead(403);return res.end('Connection revoked or unavailable');}
  }catch{res.writeHead(503);return res.end('Unable to verify connection');}
  // The owner, never an email or a token: enough to attribute a trace.
  const server=createMemoryServer(service,{ownerId:typeof claims?.sub==='string'?claims.sub:undefined});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void transport.close();void server.close();});
  try {
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  }catch{
    if(!res.headersSent)res.writeHead(500);
    res.end();
  }finally{
    // A serverless function can freeze the moment it responds, so a batched
    // exporter would lose the spans. Flushing here costs a little latency on
    // the way out and is the only point at which the trace is safe.
    await flush();
  }
}
