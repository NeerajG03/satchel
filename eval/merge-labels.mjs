#!/usr/bin/env node
// Merges label files into labels.json.
//
//   node eval/merge-labels.mjs <file.json> [...]
//
// A file may either introduce prompts that had no labels, or add judgements to
// prompts that already had some, which is what a recheck after new memories
// produces. Both are unions: a grade is only ever added, never silently
// dropped, and a conflicting grade for the same pair is refused rather than
// resolved, because quietly picking one would corrupt the ground truth.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {memoryById,promptById} from './lib/data.mjs';

const file=new URL('./labels.json',import.meta.url);
const labels=JSON.parse(readFileSync(file,'utf8'));
const problems=[];
let newPrompts=0,added=0;

for(const arg of process.argv.slice(2)){
  const incoming=JSON.parse(readFileSync(resolve(arg),'utf8'));
  for(const [pid,v] of Object.entries(incoming)){
    if(!promptById.has(pid)){problems.push(`unknown prompt ${pid}`);continue;}
    if(!labels[pid]){labels[pid]={2:[],1:[]};newPrompts++;}
    const target=labels[pid];
    for(const grade of ['2','1']){
      for(const id of v[grade]??[]){
        if(!memoryById.has(id)){problems.push(`${pid}: unknown memory ${id}`);continue;}
        const other=grade==='2'?'1':'2';
        if(target[other].includes(id)){
          problems.push(`${pid}: ${id} already graded ${other}, incoming says ${grade}`);
          continue;
        }
        if(!target[grade].includes(id)){target[grade].push(id);added++;}
      }
    }
    target['2'].sort(); target['1'].sort();
  }
}
if(problems.length){
  console.error('refused, nothing written:\n  '+problems.slice(0,10).join('\n  ')
    +(problems.length>10?`\n  ...and ${problems.length-10} more`:''));
  process.exit(1);
}
writeFileSync(file,JSON.stringify(labels,null,1)+'\n');
const g2=Object.values(labels).reduce((a,v)=>a+v['2'].length,0);
const g1=Object.values(labels).reduce((a,v)=>a+v['1'].length,0);
console.log(`merged: ${newPrompts} prompts newly labelled, ${added} judgements added`);
console.log(`labels now cover ${Object.keys(labels).length} prompts, ${g2} grade-2, ${g1} grade-1`);
