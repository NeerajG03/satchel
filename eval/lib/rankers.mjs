// Every ranker is (promptId) -> [{id, score}] sorted high to low, unfiltered.
// Gating and capping are applied on top, so a change to either is one place.
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {corpus,memoryById} from './data.mjs';

const here=p=>new URL(p,import.meta.url);

/* ---------- lexical: summed inverse document frequency ---------- */
export async function lexicalRanker(){
  const db=new PGlite();
  await db.exec(`create table memories(id text primary key, statement text,
    s tsvector generated always as (to_tsvector('english',statement)) stored);
  create index on memories using gin(s);`);
  for(const m of corpus.memories)
    await db.query('insert into memories(id,statement) values($1,$2)',[m.id,m.statement]);
  await db.exec(`
    create materialized view lexeme_df as select word lex,ndoc from ts_stat('select s from public.memories');
    create unique index on lexeme_df(lex);
    create table corpus_size as select count(*)::float n from memories;
    create function m_total(p_query text,p_vec tsvector) returns float language sql stable as $$
      select coalesce(sum(i),0) from (
        select ln((select n from corpus_size)/greatest(d.ndoc,1)) i
        from unnest(tsvector_to_array(to_tsvector('english',p_query))) q join lexeme_df d on d.lex=q
        where p_vec @@ (quote_literal(q)||'')::tsquery) x $$;`);
  const cache=new Map();
  for(const p of corpus.prompts){
    const r=await db.query(
      `select id,m_total($1,s) t from memories where m_total($1,s)>0 order by t desc,id`,[p.text]);
    cache.set(p.id,r.rows.map(x=>({id:x.id,score:x.t})));
  }
  return pid=>cache.get(pid)??[];
}

/* ---------- vector: exact cosine over cached embeddings ---------- */
const unit=v=>{const n=Math.hypot(...v);return n?v.map(x=>x/n):v;};

export function vectorRankers(){
  const dir=here('../embeddings/');
  const out={};
  if(!existsSync(dir)) return out;
  for(const f of readdirSync(dir).filter(f=>f.endsWith('.json'))){
    const c=JSON.parse(readFileSync(new URL(f,dir),'utf8'));
    const ids=Object.keys(c.memories);
    const M=ids.map(id=>unit(c.memories[id]));
    out[c.name]=pid=>{
      const q=c.prompts[pid]&&unit(c.prompts[pid]);
      if(!q) return [];
      return ids.map((id,i)=>({id,score:M[i].reduce((a,x,j)=>a+x*q[j],0)}))
        .sort((a,b)=>b.score-a.score);
    };
  }
  return out;
}

/* ---------- composition ---------- */
const minmax=l=>{
  if(!l.length) return new Map();
  const lo=Math.min(...l.map(r=>r.score)),hi=Math.max(...l.map(r=>r.score));
  return new Map(l.map(r=>[r.id,hi===lo?1:(r.score-lo)/(hi-lo)]));
};
export const hybrid=(a,b,weightA,depth=100)=>pid=>{
  const A=minmax(a(pid)),B=minmax(b(pid).slice(0,depth));
  return [...new Set([...A.keys(),...B.keys()])]
    .map(id=>({id,score:weightA*(A.get(id)??0)+(1-weightA)*(B.get(id)??0)}))
    .sort((x,y)=>y.score-x.score);
};
/** Scope boost. `inScope` names the project the session is sitting in. */
export const boost=(rank,inScope,mult)=>pid=>rank(pid)
  .map(r=>({id:r.id,score:r.score*((memoryById.get(r.id).project??'personal')===inScope?mult:1)}))
  .sort((a,b)=>b.score-a.score);

export const gate=(rank,floor)=>pid=>rank(pid).filter(r=>r.score>=floor);
export const cap=(rank,n)=>pid=>rank(pid).slice(0,n);
