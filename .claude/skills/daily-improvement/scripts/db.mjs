// Read-only access to the production database through the Supabase
// Management API, with the personal access token in `.env` in the main
// checkout (SATCHEL_REPO), then ~/.config/env.
//
// Never the service role key. Never print the token. Every query this skill
// runs is a select; anything else belongs in a change someone reviews.
import {readFileSync, existsSync} from 'node:fs';

const PROJECT = 'prpgcrwteepcunizdcut';
const REPO = process.env.SATCHEL_REPO ?? '/Volumes/Casesensitive/Github/satchel';

function token() {
  const files = [`${REPO}/.env`, `${process.env.HOME}/.config/env`];
  for (const file of files.filter(existsSync)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const clean = line.replace(/^export\s+/, '').trim();
      if (clean.startsWith('SB_TOKEN=')) return clean.slice('SB_TOKEN='.length).replace(/^['"]|['"]$/g, '');
    }
  }
  throw new Error(`SB_TOKEN is not in ${files.join(' or ')}`);
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

/** When a run began. Its row is written when it ends, after its own adds exist,
 *  so the memory set the pass saw is the set as of this moment. Without a
 *  duration the start is unknown and the set would include the run's own adds,
 *  so say so rather than guess. */
export function runStart(run) {
  if (run.duration_ms == null) console.warn(`run ${String(run.id).slice(0, 8)} has no duration_ms: its memory set may include its own adds`);
  return new Date(new Date(run.created_at).getTime() - (run.duration_ms ?? 0)).toISOString();
}
