// Final comparison with confidence intervals, plus the two design questions the
// earlier benches never tested: do the scope multipliers help, and what should
// actually be embedded.
//
//   node eval/embed.mjs && node eval/embed-variants.mjs && node eval/decide.mjs
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const here=p=>new URL(p,import.meta.url);
const corpus=JSON.parse(readFileSync(here('./corpus.json'),'utf8'));
const labels=JSON.parse(readFileSync(here('./labels.json'),'utf8'));
const K=10;
const answerable=[...corpus.prompts.keys()].filter(i=>(labels[i]?.['2']??[]).length);
const answerless=[...corpus.prompts.keys()].filter(i=>!(labels[i]?.['2']??[]).length);

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
create function m_total(p_query text,p_vec tsvector) returns float language sql stable as $$
  select coalesce(sum(i),0) from (
    select ln((select n from corpus_size)/greatest(d.ndoc,1)) i
    from unnest(tsvector_to_array(to_tsvector('english',p_query))) q join lexeme_df d on d.lex=q
    where p_vec @@ (quote_literal(q)||'')::tsquery) x $$;`);
const lex=[];
for(const p of corpus.prompts)
  lex.push((await db.query(
    `select id,m_total($1,s) t from memories where m_total($1,s)>0 order by t desc,id`,[p.text]))
    .rows.map(r=>({id:r.id,score:r.t})));

const norm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
const caches={};
for(const f of readdirSync(here('./embeddings/')).filter(f=>f.endsWith('.json'))){
  const c=JSON.parse(readFileSync(here('./embeddings/'+f),'utf8'));
  const M=c.memories.map(norm),P=c.prompts.map(norm);
  caches[c.model]=pi=>M.map((m,id)=>({id,score:m.reduce((a,x,j)=>a+x*P[pi][j],0)}))
    .sort((a,b)=>b.score-a.score);
}
const minmax=l=>{if(!l.length)return new Map();
  const lo=Math.min(...l.map(r=>r.score)),hi=Math.max(...l.map(r=>r.score));
  return new Map(l.map(r=>[r.id,hi===lo?1:(r.score-lo)/(hi-lo)]));};
const weighted=(a,b,wa)=>{const A=minmax(a),B=minmax(b);
  return [...new Set([...A.keys(),...B.keys()])].map(id=>({id,score:wa*(A.get(id)??0)+(1-wa)*(B.get(id)??0)}))
    .sort((x,y)=>y.score-x.score);};

const gradeOf=(pi,id)=>labels[pi]['2'].includes(id)?2:labels[pi]['1'].includes(id)?1:0;
const dcg=g=>g.reduce((a,v,i)=>a+(2**v-1)/Math.log2(i+2),0);
const ndcgFor=(pi,ranked)=>{
  const ideal=[...labels[pi]['2'].map(()=>2),...labels[pi]['1'].map(()=>1)].slice(0,K);
  return dcg(ranked.slice(0,K).map(r=>gradeOf(pi,r.id)))/(dcg(ideal)||1);
};
// paired bootstrap over prompts
function ci(per,resamples=2000){
  const n=per.length,means=[];
  for(let b=0;b<resamples;b++){let s=0;for(let i=0;i<n;i++)s+=per[(Math.random()*n)|0];means.push(s/n);}
  means.sort((a,b)=>a-b);
  return [means[(0.025*resamples)|0],means[(0.975*resamples)|0]];
}
const perPrompt=rank=>answerable.map(pi=>ndcgFor(pi,rank(pi)));

console.log(`${answerable.length} answerable prompts, ${answerless.length} answerless, `
  +`${Object.values(labels).reduce((a,v)=>a+v['2'].length,0)} grade-2 judgements\n`);

console.log('=== 1. ranking, with 95% bootstrap intervals ===\n');
const nomic=caches['nomic-embed-text'],mini=caches['all-minilm'];
const systems={
  'lexical (IDF sum)':          pi=>lex[pi],
  'vector all-minilm':          mini,
  'vector nomic':               nomic,
  'hybrid w=0.2 lex+nomic':     pi=>weighted(lex[pi],nomic(pi).slice(0,100),0.2),
  'hybrid w=0.3 lex+nomic':     pi=>weighted(lex[pi],nomic(pi).slice(0,100),0.3),
  'hybrid w=0.4 lex+nomic':     pi=>weighted(lex[pi],nomic(pi).slice(0,100),0.4),
  'hybrid w=0.3 lex+minilm':    pi=>weighted(lex[pi],mini(pi).slice(0,100),0.3),
};
const scored={};
console.log('system'.padEnd(28),'nDCG@10','      95% CI');
for(const [n,fn] of Object.entries(systems)){
  const per=perPrompt(fn); scored[n]=per;
  const m=per.reduce((a,b)=>a+b,0)/per.length,[lo,hi]=ci(per);
  console.log(n.padEnd(28),m.toFixed(3).padStart(6),`      [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
}
console.log('\npaired differences (positive means the first is better):');
const pairs=[['hybrid w=0.3 lex+nomic','vector nomic'],['hybrid w=0.3 lex+nomic','hybrid w=0.3 lex+minilm'],
  ['vector nomic','vector all-minilm'],['vector nomic','lexical (IDF sum)']];
for(const [a,b] of pairs){
  const d=scored[a].map((x,i)=>x-scored[b][i]);
  const m=d.reduce((x,y)=>x+y,0)/d.length,[lo,hi]=ci(d);
  const real=lo>0||hi<0?'real':'NOISE';
  console.log(`  ${(a+' - '+b).padEnd(52)} ${m>=0?'+':''}${m.toFixed(3)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]  ${real}`);
}

console.log('\n=== 2. do the scope multipliers help ===\n');
// a session sits in one repo, so one project is boosted. measure both the case
// where that is the project being asked about and the case where it is not.
const goldProject=pi=>{
  const counts={};
  for(const id of labels[pi]['2']){const p=corpus.memories[id].project??'personal';counts[p]=(counts[p]??0)+1;}
  return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0]??'personal';
};
const boosted=(rank,project,mult)=>pi=>rank(pi)
  .map(r=>({id:r.id,score:r.score*((corpus.memories[r.id].project??'personal')===project?mult:1)}))
  .sort((a,b)=>b.score-a.score);
const base=perPrompt(nomic);
const projects=[...new Set(corpus.projects.map(p=>p.slug))];
for(const mult of [2.0,3.0]){
  const right=answerable.map(pi=>ndcgFor(pi,boosted(nomic,goldProject(pi),mult)(pi)));
  const wrong=answerable.map((pi,k)=>{
    const g=goldProject(pi),other=projects.filter(p=>p!==g)[k%(projects.length-1)];
    return ndcgFor(pi,boosted(nomic,other,mult)(pi));
  });
  const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
  const dR=right.map((x,i)=>x-base[i]),dW=wrong.map((x,i)=>x-base[i]);
  const [rlo,rhi]=ci(dR),[wlo,whi]=ci(dW);
  console.log(`  x${mult.toFixed(1)} on the right project: ${mean(right).toFixed(3)} `
    +`(${dR.reduce((a,b)=>a+b,0)/dR.length>=0?'+':''}${(mean(right)-mean(base)).toFixed(3)}) [${rlo.toFixed(3)}, ${rhi.toFixed(3)}]`);
  console.log(`  x${mult.toFixed(1)} on a wrong project: ${mean(wrong).toFixed(3)} `
    +`(${(mean(wrong)-mean(base)).toFixed(3)}) [${wlo.toFixed(3)}, ${whi.toFixed(3)}]`);
}
// closed-task demotion: is a closed task's memory actually less likely to be wanted
const taskStatus=Object.fromEntries(corpus.tasks.map(t=>[t.slug,t.status]));
const closedIds=new Set(corpus.memories.map((m,i)=>m.task&&taskStatus[m.task]==='done'?i:-1).filter(i=>i>=0));
const gold2=new Set(answerable.flatMap(pi=>labels[pi]['2']));
const baseRate=closedIds.size/corpus.memories.length;
const goldRate=[...gold2].filter(id=>closedIds.has(id)).length/gold2.size;
console.log(`\n  memories hanging off a closed task: ${(100*baseRate).toFixed(1)}% of the corpus, `
  +`${(100*goldRate).toFixed(1)}% of what the labels say is relevant`);
console.log(`  ${goldRate<baseRate?'demoting them is supported':'demoting them is NOT supported by the labels'}`);

console.log('\n=== 3. what to embed ===\n');
console.log('index'.padEnd(34),'nDCG@10','      95% CI');
for(const [n,fn] of Object.entries(caches).filter(([n])=>n.includes('/'))){
  const per=perPrompt(fn),m=per.reduce((a,b)=>a+b,0)/per.length,[lo,hi]=ci(per);
  console.log(n.padEnd(34),m.toFixed(3).padStart(6),`      [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
}

console.log('\n=== 4. how big can the scope boost safely be ===\n');
// A boost multiplies a score in [0,1], so it reorders globally. The question is
// not whether it helps when right, but what it costs when wrong, and how often
// you would have to be right for it to pay.
console.log('mult'.padEnd(7),'right-project','  wrong-project','   break-even hit rate');
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const b0=mean(base);
for(const mult of [1.05,1.1,1.25,1.5,2.0,3.0]){
  const right=mean(answerable.map(pi=>ndcgFor(pi,boosted(nomic,goldProject(pi),mult)(pi))));
  const wrong=mean(answerable.map((pi,k)=>{
    const g=goldProject(pi),other=projects.filter(p=>p!==g)[k%(projects.length-1)];
    return ndcgFor(pi,boosted(nomic,other,mult)(pi));
  }));
  const gain=right-b0,loss=b0-wrong;
  const be=gain+loss<=0?NaN:loss/(gain+loss);
  console.log(String(mult).padEnd(7),
    `${gain>=0?'+':''}${gain.toFixed(3)}`.padStart(13),
    `${(wrong-b0).toFixed(3)}`.padStart(15),
    `   ${Number.isNaN(be)?'never pays':(100*be).toFixed(0)+'% of prompts'}`);
}

console.log('\n=== 5. statement+source, tested properly ===\n');
const stmt=perPrompt(caches['nomic-embed-text/statement']);
const both=perPrompt(caches['nomic-embed-text/statement+source']);
const d=both.map((x,i)=>x-stmt[i]);
const [lo,hi]=ci(d);
console.log(`  statement+source - statement: ${mean(d)>=0?'+':''}${mean(d).toFixed(3)} `
  +`[${lo.toFixed(3)}, ${hi.toFixed(3)}]  ${lo>0||hi<0?'real':'NOISE'}`);

console.log('\n=== 6. the recommended config, end to end ===\n');
const GATE=0.55;
const gated=pi=>caches['nomic-embed-text/statement+source'](pi).filter(r=>r.score>=GATE);
const cov=answerable.filter(pi=>gated(pi).length).length;
const sil=answerless.filter(pi=>!gated(pi).length).length;
const per=answerable.map(pi=>ndcgFor(pi,gated(pi)));
const [glo,ghi]=ci(per);
console.log(`  nomic-embed-text over statement+source, cosine gate ${GATE}, no fusion, no boost`);
console.log(`  nDCG@10 ${mean(per).toFixed(3)} [${glo.toFixed(3)}, ${ghi.toFixed(3)}]  `
  +`covered ${cov}/${answerable.length}  silent ${sil}/${answerless.length}`);
const rows=answerable.map(pi=>gated(pi).length);
console.log(`  rows injected per answerable prompt: median ${rows.sort((a,b)=>a-b)[rows.length>>1]}, `
  +`p90 ${rows[(0.9*rows.length)|0]}, max ${rows[rows.length-1]}`);

console.log('\n=== 7. final config, gate then cap ===\n');
console.log('index'.padEnd(22),'gate','  limit','  nDCG@10','  covered','  silent','  median rows');
for(const [idx,name] of [['nomic-embed-text/statement','statement'],
                          ['nomic-embed-text/statement+source','stmt+source']]){
  for(const g of [0.5,0.55,0.6]){
    for(const lim of [5,10]){
      const f=pi=>caches[idx](pi).filter(r=>r.score>=g).slice(0,lim);
      const per=answerable.map(pi=>ndcgFor(pi,f(pi)));
      const cov=answerable.filter(pi=>f(pi).length).length;
      const sil=answerless.filter(pi=>!f(pi).length).length;
      const rows=answerable.map(pi=>f(pi).length).sort((a,b)=>a-b);
      console.log(name.padEnd(22),String(g).padEnd(6),String(lim).padEnd(7),
        mean(per).toFixed(3).padStart(8),`  ${cov}/${answerable.length}`.padStart(9),
        `  ${sil}/${answerless.length}`.padStart(8),String(rows[rows.length>>1]).padStart(13));
    }
  }
}
const FINAL=pi=>caches['nomic-embed-text/statement'](pi)
  .map(r=>({id:r.id,score:r.score*((corpus.memories[r.id].project??'personal')===goldProject(pi)?1.1:1)}))
  .sort((a,b)=>b.score-a.score).filter(r=>r.score>=0.55).slice(0,5);
const fper=answerable.map(pi=>ndcgFor(pi,FINAL(pi)));
const [flo,fhi]=ci(fper);
console.log(`\n  with a 1.1 boost on the right project, gate 0.55, cap 5:`);
console.log(`  nDCG@10 ${mean(fper).toFixed(3)} [${flo.toFixed(3)}, ${fhi.toFixed(3)}]  `
  +`covered ${answerable.filter(pi=>FINAL(pi).length).length}/${answerable.length}  `
  +`silent ${answerless.filter(pi=>!FINAL(pi).length).length}/${answerless.length}`);
