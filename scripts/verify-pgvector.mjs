#!/usr/bin/env node
// Verifies that the HNSW index production queries through agrees with the exact
// cosine scan the eval measured. Without that agreement none of the measured
// quality transfers: an index that returns the right five rows 70% of the time
// delivers 70% of the eval's utility, whatever the eval said.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/verify-pgvector.mjs [rows] [ef_search]
//
// The token is a Supabase personal access token, the same one the CLI stores.
// The project ref is read from supabase/.temp/project-ref, or SUPABASE_PROJECT_REF.
//
// Two traps this exists to avoid, both of which produce a confident wrong answer:
//
//   Filling the probe table with uniform random vectors. In 768 dimensions
//   random vectors are all near-orthogonal, so every distance is a near-tie and
//   the true top five is arbitrary among thousands of equals. Measured that way
//   pgvector scores 35% here and looks broken. It is not; the data was.
//
//   Probing at a few hundred rows. The planner picks a sequential scan over
//   HNSW at that size, so both sides of the comparison are exact and recall
//   comes out at a meaningless 100%. The plan is asserted, never assumed.
//
// So the probe uses the real Gemini embeddings committed under eval/embeddings,
// queried by the real prompt embeddings, padded to a heavy-user row count with
// convex mixes of two real vectors. A mix stays inside the real embedding cloud.
// Per-component noise would not: a unit 768-dimension vector has components
// around 0.036, so even small-looking jitter swamps the signal and lands the row
// back in the random-vector trap above.
import {readFile} from 'node:fs/promises';

const ROWS = Number(process.argv[2] ?? 5000);
const EF_SEARCH = process.argv[3];
const FLOOR = 0.9;
const CACHE = new URL('../eval/embeddings/gemini-768_statement_source.json', import.meta.url);

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN is required (a Supabase personal access token, sbp_...).');
  process.exit(2);
}
const ref = process.env.SUPABASE_PROJECT_REF
  ?? (await readFile(new URL('../supabase/.temp/project-ref', import.meta.url), 'utf8').catch(() => '')).trim();
if (!ref) {
  console.error('No project ref. Set SUPABASE_PROJECT_REF, or link the project so supabase/.temp/project-ref exists.');
  process.exit(2);
}

async function sql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify({query}),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 600)}`);
  return JSON.parse(body);
}

const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const literal = v => `'[${v.map(x => x.toFixed(6)).join(',')}]'`;

// A seeded generator, so a recall number is reproducible and a regression is a
// real change rather than a different draw.
const seeded = s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const random = seeded(7);

const {memories, prompts, model, dims} = JSON.parse(await readFile(CACHE, 'utf8'));
const real = Object.values(memories).map(unit);
const queries = Object.values(prompts).map(unit);
const rows = [...real];
while (rows.length < ROWS) {
  const a = real[Math.floor(random() * real.length)];
  const b = real[Math.floor(random() * real.length)];
  const w = random();
  rows.push(unit(a.map((x, i) => w * x + (1 - w) * b[i])));
}

console.log(`${model} at ${dims} dimensions`);
console.log(`${rows.length} rows (${real.length} real, ${rows.length - real.length} mixed), ${queries.length} real queries`);

let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  await sql('drop table if exists public.vector_probe; drop table if exists public.vector_query; drop table if exists public.pgvector_probe_report;')
    .catch(error => console.error('Could not drop the probe tables:', error.message));
};
process.on('exit', () => { if (!cleaned) console.error('Probe tables may remain; re-run to clear them.'); });

try {
  const available = await sql("select exists(select 1 from pg_available_extensions where name='vector') as ok;");
  if (!available[0].ok) throw new Error('pgvector is not available on this instance. Memory v2 retrieval cannot ship here.');
  await sql('create extension if not exists vector with schema extensions;');

  await cleanup();
  cleaned = false;
  await sql('create table public.vector_probe(id integer primary key, embedding extensions.vector(768));');
  for (let i = 0; i < rows.length; i += 200) {
    const values = rows.slice(i, i + 200).map((v, j) => `(${i + j},${literal(v)})`).join(',');
    await sql(`insert into public.vector_probe(id,embedding) values ${values};`);
  }
  await sql('create index vector_probe_hnsw on public.vector_probe using hnsw (embedding extensions.vector_cosine_ops); analyze public.vector_probe;');
  await sql(`create table public.vector_query(id integer primary key, embedding extensions.vector(768));
    insert into public.vector_query(id,embedding) values ${queries.map((v, i) => `(${i},${literal(v)})`).join(',')};`);

  const plan = (await sql(`explain select id from public.vector_probe
    order by embedding OPERATOR(extensions.<=>) (select embedding from public.vector_query where id=0) limit 5;`))
    .map(r => r['QUERY PLAN']).join('\n');
  if (!plan.includes('vector_probe_hnsw')) {
    console.error(plan);
    console.error(`\nThe planner chose a sequential scan at ${rows.length} rows, so both sides of the`);
    console.error('comparison would be exact and recall would be a meaningless 100%. Re-run with more rows.');
    process.exitCode = 1;
    await cleanup();
    process.exit();
  }
  console.log('planner chooses HNSW: yes');

  // Every comparison runs in one transaction so `set local` actually applies.
  // Outside a transaction it is silently ignored, the exact side would use the
  // index too, and recall would come out a perfect and worthless 100%.
  const report = await sql(`
    begin;
    ${EF_SEARCH ? `set local hnsw.ef_search = ${Number(EF_SEARCH)};` : ''}
    create table public.pgvector_probe_report(measure text, value text);
    do $$
    declare
      r record; exact_ids integer[]; index_ids integer[]; overlap integer;
      total integer := 0; trials integer := 0; identical integer := 0;
      t0 timestamptz; index_ms numeric := 0; exact_ms numeric := 0;
    begin
      for r in select id, embedding from public.vector_query order by id loop
        trials := trials + 1;
        set local enable_indexscan = off; set local enable_bitmapscan = off;
        t0 := clock_timestamp();
        select array_agg(id) into exact_ids from (
          select id from public.vector_probe order by embedding OPERATOR(extensions.<=>) r.embedding limit 5) e;
        exact_ms := exact_ms + extract(epoch from clock_timestamp()-t0)*1000;

        set local enable_indexscan = on; set local enable_bitmapscan = on;
        t0 := clock_timestamp();
        select array_agg(id) into index_ids from (
          select id from public.vector_probe order by embedding OPERATOR(extensions.<=>) r.embedding limit 5) x;
        index_ms := index_ms + extract(epoch from clock_timestamp()-t0)*1000;

        select count(*) into overlap from unnest(index_ids) a where a = any(exact_ids);
        total := total + overlap;
        if overlap = 5 then identical := identical + 1; end if;
      end loop;

      insert into public.pgvector_probe_report values
        ('recall_at_5', round(1.0*total/(trials*5), 4)::text),
        ('identical_top_5', identical::text || '/' || trials::text),
        ('hnsw_mean_ms', round(index_ms/trials, 2)::text),
        ('exact_mean_ms', round(exact_ms/trials, 2)::text),
        ('ef_search', current_setting('hnsw.ef_search', true));
    end; $$;
    commit;
    select measure, value from public.pgvector_probe_report order by ctid;`);

  const measured = Object.fromEntries(report.map(r => [r.measure, r.value]));
  const recall = Number(measured.recall_at_5);
  console.log(`recall@5:            ${(recall * 100).toFixed(1)}%  (identical top 5 on ${measured.identical_top_5})`);
  console.log(`hnsw:                ${measured.hnsw_mean_ms}ms mean`);
  console.log(`exact scan:          ${measured.exact_mean_ms}ms mean`);
  console.log(`hnsw.ef_search:      ${measured.ef_search}`);

  if (recall < FLOOR) {
    console.error(`\nRecall is below ${FLOOR * 100}%. Raise hnsw.ef_search or the measured quality will not transfer.`);
    process.exitCode = 1;
  } else {
    console.log(`\nThe index agrees with the exact scan, so the eval's numbers transfer.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
