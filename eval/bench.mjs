// Lexical vs vector vs hybrid, scored against hand-labelled relevance.
//
//   node eval/embed.mjs && node eval/bench.mjs
//
// Vector search here is brute-force cosine in JS. That is a deliberate choice:
// this bench measures retrieval QUALITY, and an exact scan is the upper bound
// any pgvector index approximates. It says nothing about pgvector's operational
// cost, which is a separate question in docs/memory-v2-build.md.
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const here=p=>new URL(p,import.meta.url);
const corpus=JSON.parse(readFileSync(here('./corpus.json'),'utf8'));
const labels=JSON.parse(readFileSync(here('./labels.json'),'utf8'));
const N=corpus.memories.length, K=10;

/* ---------- lexical: summed IDF, the ranker eval/retrieval.mjs settled on ---------- */
const db=new PGlite();
await db.exec(`create table memories(id int primary key, statement text,
  s tsvector generated always as (to_tsvector('english',statement)) stored);
create index on memories using gin(s);`);
for(const [i,m] of corpus.memories.entries())
  await db.query('insert into memories(id,statement) values($1,$2)',[i,m.statement]);
await db.exec(`
create materialized view lexeme_df as select word lex,ndoc from ts_stat('select s from public.memories');
create unique index on lexeme_df(lex);
create table corpus_size as select count(*)::float n from memories;
create function m_score(p_query text,p_vec tsvector,out total float,out best float)
language sql stable as $$
  select coalesce(sum(i),0),coalesce(max(i),0) from (
    select ln((select n from corpus_size)/greatest(d.ndoc,1)) i
    from unnest(tsvector_to_array(to_tsvector('english',p_query))) q join lexeme_df d on d.lex=q
    where p_vec @@ (quote_literal(q)||'')::tsquery) x $$;`);

async function lexical(query){
  const r=await db.query(
    `select id,(m_score($1,s)).total t from memories where (m_score($1,s)).total>0 order by t desc, id`,[query]);
  return r.rows.map(x=>({id:x.id,score:x.t}));
}

/* ---------- vector: exact cosine ---------- */
const norm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
function vectorRanker(cache){
  const M=cache.memories.map(norm), P=cache.prompts.map(norm);
  return pi=>{
    const q=P[pi];
    return M.map((m,id)=>({id,score:m.reduce((a,x,j)=>a+x*q[j],0)}))
      .sort((a,b)=>b.score-a.score);
  };
}

/* ---------- fusion ---------- */
const rrf=(lists,k=60)=>{
  const acc=new Map();
  for(const list of lists) list.forEach((r,i)=>acc.set(r.id,(acc.get(r.id)??0)+1/(k+i+1)));
  return [...acc].map(([id,score])=>({id,score})).sort((a,b)=>b.score-a.score);
};
const minmax=list=>{
  if(!list.length) return new Map();
  const lo=Math.min(...list.map(r=>r.score)), hi=Math.max(...list.map(r=>r.score));
  return new Map(list.map(r=>[r.id, hi===lo?1:(r.score-lo)/(hi-lo)]));
};
const weighted=(a,b,wa)=>{
  const A=minmax(a), B=minmax(b), ids=new Set([...A.keys(),...B.keys()]);
  return [...ids].map(id=>({id,score:wa*(A.get(id)??0)+(1-wa)*(B.get(id)??0)}))
    .sort((x,y)=>y.score-x.score);
};

/* ---------- metrics ---------- */
const gradeOf=(pi,id)=>labels[pi]?.['2']?.includes(id)?2:labels[pi]?.['1']?.includes(id)?1:0;
const dcg=g=>g.reduce((a,v,i)=>a+(2**v-1)/Math.log2(i+2),0);
function evaluate(name,rankFor){
  const withGold=[], silent={correct:0,total:0,leaked:0};
  let p5=0,r5=0,mrr=0,ndcg=0,n=0;
  for(let pi=0;pi<corpus.prompts.length;pi++){
    const gold2=labels[pi]?.['2']??[];
    const ranked=rankFor(pi).slice(0,K);
    if(!gold2.length){
      silent.total++;
      if(!ranked.length) silent.correct++; else silent.leaked++;
      continue;
    }
    n++;
    const top5=ranked.slice(0,5).map(r=>r.id);
    const hit5=top5.filter(id=>gold2.includes(id)).length;
    p5+=hit5/5; r5+=hit5/gold2.length;
    const first=ranked.findIndex(r=>gold2.includes(r.id));
    mrr+=first<0?0:1/(first+1);
    const ideal=[...gold2.map(()=>2),...(labels[pi]?.['1']??[]).map(()=>1)].slice(0,K);
    ndcg+=dcg(ranked.map(r=>gradeOf(pi,r.id)))/(dcg(ideal)||1);
    withGold.push(pi);
  }
  return {name,p5:p5/n,r5:r5/n,mrr:mrr/n,ndcg:ndcg/n,n,
    silence:silent.total?silent.correct/silent.total:1,silentTotal:silent.total};
}

/* ---------- run ---------- */
const lex=[]; for(const p of corpus.prompts) lex.push(await lexical(p.text));
const models=readdirSync(new URL('./embeddings/',import.meta.url)).filter(f=>f.endsWith('.json'));
const systems=[['lexical (IDF sum)',pi=>lex[pi]]];
const vecs={};
for(const f of models){
  const cache=JSON.parse(readFileSync(new URL('./embeddings/'+f,import.meta.url),'utf8'));
  const rank=vectorRanker(cache); vecs[cache.model]=rank;
  systems.push([`vector ${cache.model} (${cache.dims}d)`,rank]);
}
for(const [model,rank] of Object.entries(vecs)){
  systems.push([`hybrid RRF  lex+${model}`, pi=>rrf([lex[pi],rank(pi).slice(0,100)])]);
  for(const w of [0.3,0.5,0.7])
    systems.push([`hybrid w=${w} lex+${model}`, pi=>weighted(lex[pi],rank(pi).slice(0,100),w)]);
}

const labelled=corpus.prompts.filter((_,i)=>(labels[i]?.['2']??[]).length).length;
console.log(`${corpus.memories.length} memories, ${corpus.prompts.length} prompts, `
  +`${labelled} with a grade-2 answer, ${corpus.prompts.length-labelled} correctly answerless\n`);
console.log('system'.padEnd(34),'P@5','  R@5','   MRR',' nDCG@10','  silence');
const rows=systems.map(([name,fn])=>evaluate(name,fn));
for(const r of rows)
  console.log(r.name.padEnd(34),r.p5.toFixed(3),r.r5.toFixed(3),r.mrr.toFixed(3),
    r.ndcg.toFixed(3).padStart(7),`  ${(100*r.silence).toFixed(0)}%`.padStart(8));
const best=[...rows].sort((a,b)=>b.ndcg-a.ndcg)[0];
console.log(`\nbest by nDCG@10: ${best.name}`);
console.log(`silence column: of the ${rows[0].silentTotal} prompts with no correct answer, `
  +`how many the system correctly returned nothing for, at no floor. A low number here is not`);
console.log('a failure of the ranker, it is the floor question: every system returns its whole tail.');

/* ---------- the floor ---------- */
// Per-query min-max normalisation makes the top row 1.0 for every query, so a
// fused score cannot carry an absolute threshold. The floor has to be read off
// a signal that means the same thing across queries. Cosine is one. Summed IDF
// is another, though it grows with query length.
console.log('\n\nthe floor: does a threshold separate "no answer" from "found it"\n');
const answerless=[...Array(corpus.prompts.length).keys()].filter(i=>!(labels[i]?.['2']??[]).length);
const answerable=[...Array(corpus.prompts.length).keys()].filter(i=>(labels[i]?.['2']??[]).length);

function sweep(name,scoreFor,floors){
  console.log(`\n${name}`);
  console.log('  floor'.padEnd(10),'answerable-covered','  answerless-silent','  R@5-of-covered');
  for(const f of floors){
    let covered=0,silent=0,r5=0;
    for(const pi of answerable){
      const kept=scoreFor(pi).filter(r=>r.score>=f).slice(0,5);
      if(kept.length){
        covered++;
        const gold=labels[pi]['2'];
        r5+=kept.filter(r=>gold.includes(r.id)).length/gold.length;
      }
    }
    for(const pi of answerless) if(!scoreFor(pi).filter(r=>r.score>=f).length) silent++;
    console.log(`  ${f}`.padEnd(10),
      `${covered}/${answerable.length}`.padStart(18),
      `${silent}/${answerless.length}`.padStart(19),
      (covered?r5/covered:0).toFixed(3).padStart(16));
  }
}
sweep('lexical, floor on summed IDF',pi=>lex[pi],[0,4,6,7,8,10,12]);
for(const [model,rank] of Object.entries(vecs))
  sweep(`vector ${model}, floor on cosine`,rank,[0,0.3,0.4,0.5,0.55,0.6,0.65,0.7]);

/* ---------- operating points ---------- */
// Ranking and gating can use different signals. Rank by whatever scores best,
// gate on whatever thresholds most cleanly.
console.log('\n\noperating points: rank by one signal, gate on another\n');
const nomic=vecs['nomic-embed-text'], mini=vecs['all-minilm'];
const gateBy=(rank,gate,floor)=>pi=>{
  const g=new Map(gate(pi).map(r=>[r.id,r.score]));
  return rank(pi).filter(r=>(g.get(r.id)??0)>=floor);
};
const configs=[
  ['nomic alone, gate 0.55',            gateBy(nomic,nomic,0.55)],
  ['nomic alone, gate 0.60',            gateBy(nomic,nomic,0.60)],
  ['hybrid w=.3 lex+nomic, gate 0.55',  gateBy(pi=>weighted(lex[pi],nomic(pi).slice(0,100),0.3),nomic,0.55)],
  ['hybrid w=.3 lex+mini,  gate 0.55',  gateBy(pi=>weighted(lex[pi],mini(pi).slice(0,100),0.3),nomic,0.55)],
  ['lexical only, gate idf>=7',         gateBy(pi=>lex[pi],pi=>lex[pi],7)],
];
console.log('config'.padEnd(36),'P@5','  R@5','   MRR',' nDCG@10','  silence','  covered');
for(const [name,fn] of configs){
  const r=evaluate(name,fn);
  const covered=answerable.filter(pi=>fn(pi).length).length;
  console.log(name.padEnd(36),r.p5.toFixed(3),r.r5.toFixed(3),r.mrr.toFixed(3),
    r.ndcg.toFixed(3).padStart(7),`  ${(100*r.silence).toFixed(0)}%`.padStart(8),
    `  ${covered}/${answerable.length}`.padStart(9));
}
console.log(`
  metrics above are over all ${answerable.length} answerable prompts, so a gated config is
  penalised for every prompt it stays silent on. That is the honest comparison:
  silence is not free.`);
