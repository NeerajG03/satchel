#!/usr/bin/env node
// Merges generated prompts and memories into the corpus, assigning fresh stable
// ids. Existing ids never move, so existing labels stay valid.
//
//   node eval/merge.mjs <file.json> [...]
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const file=new URL('./corpus.json',import.meta.url);
const corpus=JSON.parse(readFileSync(file,'utf8'));
const projects=new Set(corpus.projects.map(p=>p.slug));
const tasks=new Map(corpus.tasks.map(t=>[t.slug,t]));
const nextId=(list,prefix,width)=>{
  let n=list.reduce((a,x)=>Math.max(a,+x.id.slice(prefix.length)),-1);
  return ()=>prefix+String(++n).padStart(width,'0');
};
const newMemoryId=nextId(corpus.memories,'m',4);
const newPromptId=nextId(corpus.prompts,'p',3);
const seenText=new Set(corpus.prompts.map(p=>p.text.toLowerCase().trim()));
const seenStmt=new Set(corpus.memories.map(m=>m.statement.toLowerCase().trim()));

let addedM=0,addedP=0,skipped=0;
const problems=[];
for(const arg of process.argv.slice(2)){
  const rows=JSON.parse(readFileSync(resolve(arg),'utf8'));
  for(const r of rows){
    if(r.text!==undefined){
      const key=r.text.toLowerCase().trim();
      if(seenText.has(key)){skipped++;continue;}
      seenText.add(key);
      corpus.prompts.push({id:newPromptId(),text:r.text,
        context:r.context??'cold-start',category:r.category??'unlabelled'});
      addedP++;
    } else if(r.statement!==undefined){
      const key=r.statement.toLowerCase().trim();
      if(seenStmt.has(key)){skipped++;continue;}
      seenStmt.add(key);
      if(r.project!==null&&!projects.has(r.project)){problems.push(`unknown project ${r.project}`);continue;}
      if(r.task!==null&&r.task!==undefined){
        const t=tasks.get(r.task);
        if(!t){problems.push(`unknown task ${r.task}`);continue;}
        if(t.project!==r.project){problems.push(`task ${r.task} scope disagrees`);continue;}
      }
      corpus.memories.push({id:newMemoryId(),statement:r.statement,source:r.source,
        band:r.band,project:r.project??null,task:r.task??null,
        ...(r.edge_case?{edge_case:r.edge_case}:{}),
        ...(r.supersedes?{supersedes:r.supersedes}:{})});
      addedM++;
    } else problems.push(`row is neither a prompt nor a memory: ${JSON.stringify(r).slice(0,60)}`);
  }
}
if(problems.length){
  console.error('refused, nothing written:\n  '+problems.slice(0,10).join('\n  '));
  process.exit(1);
}
writeFileSync(file,JSON.stringify(corpus,null,1));
console.log(`merged +${addedM} memories, +${addedP} prompts, ${skipped} duplicates skipped`);
console.log(`corpus now ${corpus.memories.length} memories, ${corpus.prompts.length} prompts`);
