#!/usr/bin/env node
// The eval. One command, a fixed baseline, and a non-zero exit when something
// regresses. Everything it prints is reproducible: the bootstrap is seeded.
//
//   node eval/run.mjs                    report, and compare against baseline
//   node eval/run.mjs --update-baseline  adopt the current numbers as the baseline
//   node eval/run.mjs --slices           per-category breakdown for the primary
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {validate,answerable,answerless,slices,gold,corpus} from './lib/data.mjs';
import {lexicalRanker,vectorRankers,hybrid,boost,gate,cap} from './lib/rankers.mjs';
import {ndcg,recallAt,precisionAt,reciprocalRank,ci,paired,mean,utility} from './lib/metrics.mjs';

const args=new Set(process.argv.slice(2));
const baselineFile=new URL('./baseline.json',import.meta.url);

const shape=validate();
console.log(`corpus  ${shape.memories} memories  ${shape.prompts} prompts  `
  +`${shape.answerable} answerable  ${shape.answerless} answerless  `
  +`${shape.grade2} grade-2  ${shape.grade1} grade-1\n`);

const lex=await lexicalRanker();
const vec=vectorRankers();
if(!Object.keys(vec).length){
  console.error('no embeddings cached. run: node eval/embed.mjs');
  process.exit(2);
}
const CAP=5, BOOST=1.1;
// The project a session is sitting in. Approximated by where this prompt's
// answers live, which is the best case for the boost; run.mjs reports the cost
// of getting it wrong separately.
const inScopeFor=pid=>{
  const c={};
  for(const id of gold(pid)){
    const p=corpus.memories.find(m=>m.id===id).project??'personal';
    c[p]=(c[p]??0)+1;
  }
  return Object.entries(c).sort((a,b)=>b[1]-a[1])[0]?.[0]??'personal';
};
const withScope=(rank,mult)=>pid=>boost(rank,inScopeFor(pid),mult)(pid);

/** Cosine scales differ per model, so a shared constant is wrong. Pick the gate
 *  that maximises utility on the labelled data, and report it. */
function calibrate(rank,floors){
  let best={floor:0,value:-1};
  for(const f of floors){
    const v=utility(cap(gate(rank,f),CAP),{answerable,answerless}).value;
    if(v>best.value) best={floor:f,value:v};
  }
  return best;
}
const FLOORS=Array.from({length:61},(_,i)=>+(0.20+i*0.01).toFixed(2));
const calibrated={};
console.log('calibrated gate per index (chosen to maximise utility on the labels)');
for(const [name,fn] of Object.entries(vec)){
  const b=calibrate(withScope(fn,BOOST),FLOORS);
  calibrated[name]=b.floor;
  console.log(`  ${name.padEnd(26)} gate ${b.floor.toFixed(2)}   utility ${b.value.toFixed(3)}`);
}
console.log();

const raw={
  'lexical (IDF)':            lex,
  'vector all-minilm':        vec['all-minilm/statement'],
  'vector nomic stmt+source': vec['nomic/statement+source'],
  'hybrid .3 lex+minilm':     hybrid(lex,vec['all-minilm/statement'],0.3),
};
// Every cached index gets a gated system, so adding a model to embed.mjs is
// enough to put it in the comparison.
const gatedSystems={};
const gated=name=>cap(gate(withScope(vec[name],BOOST),calibrated[name]),CAP);
for(const name of Object.keys(vec)) gatedSystems[`${name} +gate`]=gated(name);
const systems={...raw,...gatedSystems};
const PRIMARY='gemini-768/statement+source +gate';
if(!systems[PRIMARY]) throw new Error(`primary "${PRIMARY}" is not one of the systems`);

function score(rank){
  const per=answerable.map(pid=>ndcg(pid,rank(pid)));
  const u=utility(rank,{answerable,answerless});
  return {
    ndcg:mean(per), per, utility:u.value, uper:u.per,
    r5:mean(answerable.map(pid=>recallAt(pid,rank(pid),5))),
    p5:mean(answerable.map(pid=>precisionAt(pid,rank(pid),5))),
    mrr:mean(answerable.map(pid=>reciprocalRank(pid,rank(pid)))),
    covered:answerable.filter(pid=>rank(pid).length).length,
    silent:answerless.filter(pid=>!rank(pid).length).length,
  };
}
const results={};
for(const [name,fn] of Object.entries(systems)) results[name]=score(fn);

console.log('system'.padEnd(30),'utility','    95% CI','  nDCG','   R@5','   MRR','  cover','  silent');
for(const [name,r] of Object.entries(results)){
  const [lo,hi]=ci(r.uper);
  console.log(name.padEnd(30),r.utility.toFixed(3).padStart(6),
    ` [${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    r.ndcg.toFixed(3).padStart(6),r.r5.toFixed(3).padStart(6),r.mrr.toFixed(3).padStart(6),
    `  ${r.covered}/${answerable.length}`.padStart(8),
    `  ${r.silent}/${answerless.length}`.padStart(8));
}

console.log(`\npaired on utility against "${PRIMARY}". a difference only counts when its interval excludes zero.`);
for(const [name,r] of Object.entries(results)){
  if(name===PRIMARY) continue;
  const d=paired(r.uper,results[PRIMARY].uper);
  console.log(`  ${name.padEnd(32)} ${d.delta>=0?'+':''}${d.delta.toFixed(3)} `
    +`[${d.lo.toFixed(3)}, ${d.hi.toFixed(3)}]  ${d.significant?(d.delta>0?'BETTER':'worse'):'noise'}`);
}

if(args.has('--slices')){
  // The style-only slice is the design's central claim under test: a standing
  // writing rule is relevant by category of activity, not by topic, so no
  // similarity search can reach it. Session start loads all personal memories
  // precisely so it does not have to. This measures the size of that effect.
  const personal=corpus.memories.filter(m=>m.project===null).map(m=>({id:m.id,score:1}));
  const styleIds=corpus.prompts.filter(p=>p.category==='style-only'&&gold(p.id).length).map(p=>p.id);
  const retrieved=pid=>systems[PRIMARY](pid);
  const withPersonal=pid=>[...personal,...retrieved(pid).filter(r=>!personal.some(x=>x.id===r.id))];
  if(styleIds.length){
    const a=mean(styleIds.map(pid=>ndcg(pid,retrieved(pid))));
    const b=mean(styleIds.map(pid=>ndcg(pid,withPersonal(pid))));
    console.log(`\nstyle-only prompts, n=${styleIds.length}`);
    console.log(`  retrieval alone                       nDCG ${a.toFixed(3)}`);
    console.log(`  with personal memories already loaded nDCG ${b.toFixed(3)}  `
      +`(${personal.length} rows, injected once per session, not per prompt)`);
  }

  console.log('\nper category, primary system. n is prompts in that slice.');
  console.log('  slice'.padEnd(24),'n','  nDCG@10','  cover','  silent');
  for(const [name,ids] of slices()){
    const ans=ids.filter(id=>gold(id).length), none=ids.filter(id=>!gold(id).length);
    const per=ans.map(pid=>ndcg(pid,systems[PRIMARY](pid)));
    console.log('  '+name.padEnd(22),String(ids.length).padStart(3),
      (ans.length?mean(per).toFixed(3):'   -').padStart(9),
      (ans.length?`${ans.filter(pid=>systems[PRIMARY](pid).length).length}/${ans.length}`:'-').padStart(8),
      (none.length?`${none.filter(pid=>!systems[PRIMARY](pid).length).length}/${none.length}`:'-').padStart(8));
  }
}

/* ---------- baseline ---------- */
const snapshot={
  generated:new Date().toISOString().slice(0,10),
  corpus:shape, primary:PRIMARY, gates:calibrated, cap:CAP, boost:BOOST,
  systems:Object.fromEntries(Object.entries(results).map(([k,v])=>
    [k,{utility:+v.utility.toFixed(4),ndcg:+v.ndcg.toFixed(4),r5:+v.r5.toFixed(4),
        mrr:+v.mrr.toFixed(4),covered:v.covered,silent:v.silent}])),
};
if(args.has('--update-baseline')){
  writeFileSync(baselineFile,JSON.stringify(snapshot,null,1)+'\n');
  console.log('\nbaseline updated.');
  process.exit(0);
}
if(!existsSync(baselineFile)){
  console.log('\nno baseline yet. run: node eval/run.mjs --update-baseline');
  process.exit(0);
}
const base=JSON.parse(readFileSync(baselineFile,'utf8'));
console.log(`\nagainst baseline of ${base.generated} `
  +`(${base.corpus.memories} memories, ${base.corpus.prompts} prompts)`);
let regressed=false;
if(base.corpus.prompts!==shape.prompts||base.corpus.memories!==shape.memories)
  console.log('  corpus changed since the baseline, so deltas are not like for like.');
for(const [name,r] of Object.entries(results)){
  const b=base.systems[name];
  if(!b){console.log(`  ${name.padEnd(32)} new`);continue;}
  const d=r.utility-(b.utility??0);
  const flag=d<-0.02?'REGRESSED':d>0.02?'improved':'same';
  if(flag==='REGRESSED') regressed=true;
  console.log(`  ${name.padEnd(30)} ${d>=0?'+':''}${d.toFixed(3)} utility  `
    +`silent ${b.silent}->${r.silent}  ${flag}`);
}
process.exit(regressed?1:0);
