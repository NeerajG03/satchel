import {handleIntegrations} from '../server/integrations-handler.mjs';
import {flush} from '../server/tracing.mjs';

export default async function handler(req, res) {
  try { await handleIntegrations(req, res); }
  finally { await flush(); }
}
