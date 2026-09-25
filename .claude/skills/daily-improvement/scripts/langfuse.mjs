// Read-only Langfuse access for the consolidation traces.
//
// Only the v2 observations list works for this organisation; traces and
// single observations by id answer 410 or 404. See
// .claude/skills/debugging/references/langfuse.md, and ask for the fields:
// the default projection leaves out the model, the usage and the metadata.
import {readFileSync} from 'node:fs';

function env() {
  const out = {};
  for (const line of readFileSync(`${process.env.HOME}/.config/env`, 'utf8').split('\n')) {
    const clean = line.replace(/^export\s+/, '').trim();
    const at = clean.indexOf('=');
    if (at > 0 && clean.startsWith('LANGFUSE_')) out[clean.slice(0, at)] = clean.slice(at + 1).replace(/^['"]|['"]$/g, '');
  }
  if (!out.LANGFUSE_PUBLIC_KEY || !out.LANGFUSE_SECRET_KEY || !out.LANGFUSE_BASE_URL)
    throw new Error('Langfuse keys are not in ~/.config/env');
  return out;
}

/** Every observation that started in the window, paged. */
export async function observations(since, until, {limit = 5000} = {}) {
  const e = env();
  const auth = Buffer.from(`${e.LANGFUSE_PUBLIC_KEY}:${e.LANGFUSE_SECRET_KEY}`).toString('base64');
  const all = [];
  let cursor = null;
  do {
    const url = new URL(`${e.LANGFUSE_BASE_URL}/api/public/v2/observations`);
    url.searchParams.set('fromStartTime', since);
    url.searchParams.set('toStartTime', until);
    url.searchParams.set('limit', '100');
    url.searchParams.set('fields', 'core,basic,metadata,model,usage,metrics');
    if (cursor) url.searchParams.set('cursor', cursor);
    let res = await fetch(url, {headers: {authorization: `Basic ${auth}`}});
    // Thirty requests a minute. A busy night pages past that, so wait out the
    // window it names rather than lose the whole witness.
    for (let tries = 0; res.status === 429 && tries < 5; tries++) {
      const body = await res.json().catch(() => ({}));
      await new Promise(done => setTimeout(done, ((body.details?.retryAfterSeconds ?? 60) + 1) * 1000));
      res = await fetch(url, {headers: {authorization: `Basic ${auth}`}});
    }
    if (!res.ok) throw new Error(`Langfuse said ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    all.push(...(body.data ?? []));
    cursor = body.meta?.cursor ?? null;
  } while (cursor && all.length < limit);
  return all;
}

/** One line per trace: what the span recorded and what the model call cost. */
export function summarize(rows, traceIds) {
  const wanted = new Set(traceIds);
  const byTrace = {};
  for (const row of rows) {
    if (!wanted.has(row.traceId)) continue;
    const t = byTrace[row.traceId] ??= {generations: []};
    if (row.type === 'SPAN' && String(row.name).startsWith('satchel.')) {
      t.span = row.name; t.metadata = row.metadata ?? {}; t.latency_s = row.latency ?? null;
      t.level = row.level; t.status = row.statusMessage ?? null;
    }
    if (row.type === 'GENERATION') t.generations.push({
      model: row.providedModelName ?? row.model ?? null, level: row.level, status: row.statusMessage ?? null,
      usage: row.usageDetails ?? null, cost: row.costDetails?.total ?? null, latency_s: row.latency ?? null,
      thinking: row.metadata?.thinking ?? row.modelParameters?.thinkingLevel ?? null,
    });
  }
  return byTrace;
}
