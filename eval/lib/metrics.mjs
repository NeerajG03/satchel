// Metrics and significance. The bootstrap is seeded, so two runs of the same
// code give the same intervals and a diff means a real change.
import {gold,helpful} from './data.mjs';

export const K=10;
const dcg=g=>g.reduce((a,v,i)=>a+(2**v-1)/Math.log2(i+2),0);

export function gradeOf(pid,id){
  return gold(pid).includes(id)?2:helpful(pid).includes(id)?1:0;
}
export function ndcg(pid,ranked,k=K){
  const ideal=[...gold(pid).map(()=>2),...helpful(pid).map(()=>1)].slice(0,k);
  const d=dcg(ideal);
  return d?dcg(ranked.slice(0,k).map(r=>gradeOf(pid,r.id)))/d:0;
}
export function recallAt(pid,ranked,k=5){
  const g=gold(pid); if(!g.length) return 0;
  return ranked.slice(0,k).filter(r=>g.includes(r.id)).length/g.length;
}
export function precisionAt(pid,ranked,k=5){
  const g=gold(pid);
  return ranked.slice(0,k).filter(r=>g.includes(r.id)).length/k;
}
export function reciprocalRank(pid,ranked){
  const g=gold(pid);
  const i=ranked.findIndex(r=>g.includes(r.id));
  return i<0?0:1/(i+1);
}

// mulberry32: small, fast, and seeded so results are reproducible.
function rng(seed){
  return ()=>{seed|=0;seed=seed+0x6D2B79F5|0;
    let t=Math.imul(seed^seed>>>15,1|seed);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;};
}
export const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;

/** 95% interval for the mean of per-prompt scores. */
export function ci(per,{resamples=2000,seed=20260920}={}){
  if(per.length<2) return [NaN,NaN];
  const rand=rng(seed),n=per.length,means=[];
  for(let b=0;b<resamples;b++){
    let s=0; for(let i=0;i<n;i++) s+=per[(rand()*n)|0];
    means.push(s/n);
  }
  means.sort((a,b)=>a-b);
  return [means[Math.floor(0.025*resamples)],means[Math.floor(0.975*resamples)]];
}

/** Paired difference. Same prompts, same resample draws, so it tests the change
 *  rather than the variation between prompts. */
export function paired(a,b,opts){
  const d=a.map((x,i)=>x-b[i]);
  const [lo,hi]=ci(d,opts);
  return {delta:mean(d),lo,hi,significant:lo>0||hi<0};
}

/** One number for the whole system.
 *
 *  A prompt with an answer scores its nDCG@10. A prompt with no answer scores 1
 *  when the system stays quiet and 0 when it injects noise. The mean over every
 *  prompt is what a user actually experiences, and it is the only way to compare
 *  a system that answers more against one that interrupts less.
 *
 *  It is only as honest as the ratio of answerable to answerless prompts in the
 *  corpus, so that ratio is printed next to it.
 */
export function utility(rank,{answerable,answerless}){
  const a=answerable.map(pid=>ndcg(pid,rank(pid)));
  const s=answerless.map(pid=>rank(pid).length?0:1);
  return {per:[...a,...s],value:mean([...a,...s]),answered:mean(a),silence:mean(s)};
}
