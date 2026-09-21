// Session start. Deliberately importing nothing but the handler: this endpoint
// runs inside a hook timeout at the moment a session opens, so its cold start
// is the thing that decides whether memory arrives at all.
// tests/endpoint-imports.test.mjs is what keeps that true.
export {handleHookIndex as default} from '../server/hook-handler.mjs';
