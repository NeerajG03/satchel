import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const dir=new URL('../../supabase/migrations/',import.meta.url);
export const RETRIEVAL='20260920090000_memory_v2_retrieval.sql';

// PGlite has no pgvector, so the type and the distance operator are shimmed for
// tests. The real operator and the real index are verified against Supabase by
// scripts/verify-pgvector.mjs, which is the only place they can be.
const EXTENSION='create extension if not exists vector with schema extensions;';
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

/** Rewrites one migration so PGlite can run it.
 *
 *  Driven by what the file contains, not by its name. Keying on the filename
 *  meant a later migration that also declared extensions.vector(768) reached
 *  PGlite unshimmed and failed on a domain that cannot take a type modifier,
 *  which is a confusing way to learn that the helper needed updating. */
export function shimVector(sql){
  if(!sql.includes('extensions.vector'))return sql;
  let out=sql.includes(EXTENSION)?sql.replace(EXTENSION,()=>SHIM):sql;
  const before=out;
  // Function replacers throughout: `$$` in a replacement string is an escape
  // and would silently break the shim's dollar quoting.
  out=out.replace(/extensions\.vector\(768\)/g,()=>'extensions.vector')
         .replace(/create index \w+_hnsw[\s\S]*?;/g,()=>'-- index omitted: no hnsw access method in the shim');
  assert.notEqual(out,before,
    'a migration naming extensions.vector was left unshimmed, so it would fail on the domain');
  return out;
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
    await db.exec(shimVector(sql));
  }
  return list;
}
