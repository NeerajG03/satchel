import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const dir=new URL('../../supabase/migrations/',import.meta.url);
export const RETRIEVAL='20260920090000_memory_v2_retrieval.sql';

// PGlite has no pgvector, so the type and the distance operator are shimmed for
// tests. Every substitution is asserted to match, so a change to the migration's
// shape fails loudly here instead of quietly testing something else. The real
// operator is verified against Supabase by scripts/verify-pgvector.mjs.
const SHIM=`
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated;
create domain extensions.vector as real[];
create function extensions.vec_cosine_distance(a real[], b real[]) returns real
language sql immutable as $$
  select (1 - (
    (select sum(x*y) from unnest(a,b) t(x,y))
    / (sqrt((select sum(x*x) from unnest(a) x)) * sqrt((select sum(y*y) from unnest(b) y)))
  ))::real
$$;
create operator extensions.<=> (leftarg=real[], rightarg=real[], function=extensions.vec_cosine_distance);
`;

export function shimVector(sql){
  const edits=[
    [/create extension if not exists vector with schema extensions;/, SHIM],
    [/extensions\.vector\(768\)/g, 'extensions.vector'],
    [/create index memories_embedding_hnsw[\s\S]*?;/, '-- index omitted: no hnsw access method in the shim'],
  ];
  for(const [pattern,replacement] of edits){
    assert.ok(pattern.test(sql),`the retrieval migration no longer contains ${pattern}`);
    // A function replacer: `$$` in a replacement string is an escape and would
    // silently break the shim's dollar quoting.
    sql=sql.replace(pattern,()=>replacement);
  }
  return sql;
}

export async function migrationFiles(){
  return (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort();
}

/** Applies migrations in order, shimming pgvector. `through` stops after that file. */
export async function applyMigrations(db,{files,through}={}){
  const all=files??await migrationFiles();
  const list=through?all.slice(0,all.indexOf(through)+1):all;
  for(const file of list){
    const sql=await readFile(new URL(file,dir),'utf8');
    await db.exec(file===RETRIEVAL?shimVector(sql):sql);
  }
  return list;
}
