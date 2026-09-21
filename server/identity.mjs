// Who this deployment is, as constants and nothing else.
//
// These four values used to live in http-handler.mjs, which is also where the
// MCP server, the Supabase client, the embedder and the router are built. That
// made them expensive to read: /api/repository-hint needs one string from here
// and was paying for the entire model stack to get it, on every cold start.
//
//   api/repository-hint.mjs
//     └── repository-hint-handler.mjs
//           └── http-handler.mjs        ← for SUPABASE_URL alone
//                 ├── jose, @supabase/supabase-js, @modelcontextprotocol/sdk
//                 └── embedding.mjs, router.mjs  →  ai, @ai-sdk/*
//
// That endpoint is the one the plugin bootstrap waits on with a 2.5 second
// timeout, and a cold start over that budget is what produces "could not stage
// it for the authenticated lifecycle hook" and sends the model down the manual
// select_project path instead.
//
// Nothing here may import anything. That is the whole point of the file, so a
// future import is the thing to refuse in review.
export const RESOURCE = 'https://satchel-pi.vercel.app/api/mcp';
export const SUPABASE_URL = 'https://prpgcrwteepcunizdcut.supabase.co';
export const ISSUER = SUPABASE_URL + '/auth/v1';

/** The OAuth protected-resource document, served at /.well-known. Static, so
 *  the endpoint serving it has no reason to load a request handler. */
export const metadata = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: ['openid'],
  resource_name: 'Satchel',
};
