// Read-only access to the production database through the Supabase
// Management API, with the personal access token in ~/.config/env.
//
// Never the service role key. Never print the token. Every query this skill
// runs is a select; anything else belongs in a change someone reviews.
import {readFileSync} from 'node:fs';

const PROJECT = 'prpgcrwteepcunizdcut';

function token() {
  const lines = readFileSync(`${process.env.HOME}/.config/env`, 'utf8').split('\n');
  for (const line of lines) {
    const clean = line.replace(/^export\s+/, '').trim();
    if (clean.startsWith('SB_TOKEN=')) return clean.slice('SB_TOKEN='.length).replace(/^['"]|['"]$/g, '');
  }
  throw new Error('SB_TOKEN is not in ~/.config/env');
}

export async function sql(query) {
  if (!/^\s*(select|with)\b/i.test(query)) throw new Error('this skill only reads');
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: {authorization: `Bearer ${token()}`, 'content-type': 'application/json'},
    body: JSON.stringify({query}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`database said ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Quote a value for a literal. Only ever used on ids and timestamps that came
 *  out of the database or were checked as dates. */
export const lit = value => value === null || value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`;
