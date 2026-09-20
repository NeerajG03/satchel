-- Verifies the two things about pgvector that the eval could not.
--
-- The eval measured an exact cosine scan in JavaScript. Production uses an HNSW
-- index, which is approximate by construction, so the numbers only transfer if
-- the index agrees with the exact answer often enough. This measures that
-- agreement, and the latency, against the real database.
--
-- Run in the Supabase SQL editor, or: psql "$SUPABASE_DB_URL" -f scripts/verify-pgvector.sql
-- It creates and drops its own temporary table and touches nothing else.

\timing on

do $$
declare
  available boolean;
  installed boolean;
begin
  select exists(select 1 from pg_available_extensions where name = 'vector') into available;
  select exists(select 1 from pg_extension where extname = 'vector') into installed;
  raise notice 'pgvector available: %, installed: %', available, installed;
  if not available then
    raise exception 'pgvector is not available on this instance. Memory v2 retrieval cannot ship here.';
  end if;
  if not installed then
    raise notice 'Not installed yet. The migration runs: create extension if not exists vector with schema extensions;';
  end if;
end;
$$;

create extension if not exists vector with schema extensions;

create temporary table vector_probe (
  id integer primary key,
  embedding extensions.vector(768)
) on commit drop;

-- 5,000 rows is a heavy single user: the design worries about ten projects at a
-- hundred memories each, so this is five times that.
insert into vector_probe (id, embedding)
select g, (
  select ('[' || string_agg((random() * 2 - 1)::text, ',') || ']')::extensions.vector(768)
  from generate_series(1, 768)
)
from generate_series(1, 5000) g;

create index vector_probe_hnsw on vector_probe
  using hnsw (embedding extensions.vector_cosine_ops);

analyze vector_probe;

-- Recall at 5: how often the index returns what an exact scan would have.
do $$
declare
  query extensions.vector(768);
  exact_ids integer[];
  index_ids integer[];
  overlap integer;
  total integer := 0;
  trials integer := 20;
begin
  for i in 1..trials loop
    select embedding into query from vector_probe where id = (random() * 4999)::int + 1;

    set local enable_indexscan = off;
    set local enable_bitmapscan = off;
    select array_agg(id order by embedding OPERATOR(extensions.<=>) query)
      into exact_ids from (
        select id, embedding from vector_probe
        order by embedding OPERATOR(extensions.<=>) query limit 5) e;

    set local enable_indexscan = on;
    set local enable_bitmapscan = on;
    select array_agg(id order by embedding OPERATOR(extensions.<=>) query)
      into index_ids from (
        select id, embedding from vector_probe
        order by embedding OPERATOR(extensions.<=>) query limit 5) x;

    select count(*) into overlap
      from unnest(index_ids) a where a = any(exact_ids);
    total := total + overlap;
  end loop;

  raise notice 'HNSW recall@5 over % queries: %%%', trials, round(100.0 * total / (trials * 5), 1);
  if total < trials * 5 * 0.9 then
    raise warning 'Recall is below 90%%. Raise hnsw.ef_search, or the measured quality will not transfer.';
  end if;
end;
$$;

-- Latency. The per-prompt hook budget is about 100ms end to end, and most of
-- that belongs to the network and the embedding call, not to this query.
explain (analyze, buffers, timing)
select id from vector_probe
order by embedding OPERATOR(extensions.<=>) (
  select embedding from vector_probe where id = 1)
limit 5;

drop index vector_probe_hnsw;
drop table vector_probe;
