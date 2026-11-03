import {handleGoogle} from '../server/google-handler.mjs';
import {flush} from '../server/tracing.mjs';

export default async function handler(req, res) {
  try { await handleGoogle(req, res); }
  finally { await flush(); }
}
