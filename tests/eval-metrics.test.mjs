import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// The eval harness decides which retrieval design ships, so its arithmetic is
// worth testing directly. A silently wrong nDCG makes every conclusion wrong.
const metrics=await import('../eval/lib/metrics.mjs');
const {ndcg,recallAt,precisionAt,reciprocalRank,ci,paired,mean,utility,gradeOf}=metrics;

// The module reads the real labels, so tests pin themselves to a real prompt.
const labels=JSON.parse(readFileSync(new URL('../eval/labels.json',import.meta.url),'utf8'));
const pid=Object.keys(labels).find(k=>labels[k]['2'].length>=3);
const g=labels[pid]['2'];
const rank=ids=>ids.map(id=>({id}));

test('grades come from the labels', () => {
  assert.equal(gradeOf(pid,g[0]),2);
  assert.equal(gradeOf(pid,'m9999'),0);
  if(labels[pid]['1'].length) assert.equal(gradeOf(pid,labels[pid]['1'][0]),1);
});

test('a perfect ranking scores 1 and an empty one scores 0', () => {
  const ideal=[...labels[pid]['2'],...labels[pid]['1']];
  assert.equal(ndcg(pid,rank(ideal)),1);
  assert.equal(ndcg(pid,[]),0);
});

test('nDCG rewards putting the right answer higher', () => {
  const good=ndcg(pid,rank([g[0],'m9999','m9998']));
  const bad =ndcg(pid,rank(['m9999','m9998',g[0]]));
  assert.ok(good>bad,`${good} should beat ${bad}`);
});

test('recall and precision at 5 count only grade 2', () => {
  const r=rank([g[0],g[1],'m9999','m9998','m9997']);
  assert.equal(precisionAt(pid,r,5),2/5);
  assert.equal(recallAt(pid,r,5),2/g.length);
  // a grade-1 row is not a hit
  if(labels[pid]['1'].length)
    assert.equal(precisionAt(pid,rank([labels[pid]['1'][0]]),5),0);
});

test('reciprocal rank is the position of the first correct row', () => {
  assert.equal(reciprocalRank(pid,rank([g[0]])),1);
  assert.equal(reciprocalRank(pid,rank(['m9999',g[0]])),1/2);
  assert.equal(reciprocalRank(pid,rank(['m9999','m9998'])),0);
});

test('nothing beyond k counts', () => {
  const padding=Array.from({length:10},(_,i)=>`m99${i}0`);
  assert.equal(ndcg(pid,rank([...padding,g[0]]),10),0);
});

test('utility trades answering against staying quiet', () => {
  const answerable=[pid], answerless=['__none__'];
  const always=()=>rank([g[0]]);
  const never=()=>[];
  const a=utility(always,{answerable,answerless});
  const n=utility(never,{answerable,answerless});
  // answering correctly but never shutting up
  assert.ok(a.answered>0); assert.equal(a.silence,0);
  // silent always: perfect on the answerless prompt, zero on the answerable one
  assert.equal(n.answered,0); assert.equal(n.silence,1);
  assert.equal(n.value,0.5);
});

test('the bootstrap is seeded, so a run is reproducible', () => {
  const per=Array.from({length:40},(_,i)=>(i%7)/7);
  assert.deepEqual(ci(per),ci(per));
  const [lo,hi]=ci(per);
  assert.ok(lo<mean(per)&&mean(per)<hi,'the interval must contain the mean');
});

test('a paired difference against itself is exactly zero and not significant', () => {
  const a=Array.from({length:40},(_,i)=>(i%5)/5);
  const d=paired(a,a);
  assert.equal(d.delta,0);
  assert.equal(d.significant,false);
});

test('a consistent difference is detected, a noisy one is not', () => {
  const a=Array.from({length:60},(_,i)=>0.5+(i%3)*0.01);
  const real=a.map(x=>x-0.2);
  assert.equal(paired(a,real).significant,true,'a uniform 0.2 gap must be significant');
  const noisy=a.map((x,i)=>x+(i%2?0.2:-0.2));
  assert.equal(paired(a,noisy).significant,false,'a zero-mean swing must not be');
});
