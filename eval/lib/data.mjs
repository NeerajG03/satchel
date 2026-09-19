// Loading and integrity. Everything is keyed by stable id, never by array
// position, so the corpus can grow without invalidating a single label.
import {readFileSync} from 'node:fs';

const here=p=>new URL(p,import.meta.url);
export const corpus=JSON.parse(readFileSync(here('../corpus.json'),'utf8'));
export const labels=JSON.parse(readFileSync(here('../labels.json'),'utf8'));

export const memoryById=new Map(corpus.memories.map(m=>[m.id,m]));
export const promptById=new Map(corpus.prompts.map(p=>[p.id,p]));

export const gold=pid=>labels[pid]?.['2']??[];
export const helpful=pid=>labels[pid]?.['1']??[];
export const answerable=corpus.prompts.filter(p=>gold(p.id).length).map(p=>p.id);
export const answerless=corpus.prompts.filter(p=>!gold(p.id).length).map(p=>p.id);

/** Throws on anything that would make a measurement meaningless. */
export function validate(){
  const problems=[];
  const seen=new Set();
  for(const m of corpus.memories){
    if(!/^m\d{4}$/.test(m.id)) problems.push(`memory id malformed: ${m.id}`);
    if(seen.has(m.id)) problems.push(`duplicate memory id: ${m.id}`);
    seen.add(m.id);
    if(!m.statement?.trim()) problems.push(`${m.id}: empty statement`);
    if(m.statement?.length>500) problems.push(`${m.id}: statement over 500 chars`);
    if(!['said','heard'].includes(m.band)) problems.push(`${m.id}: bad band ${m.band}`);
  }
  const projects=new Set(corpus.projects.map(p=>p.slug));
  const tasks=new Map(corpus.tasks.map(t=>[t.slug,t]));
  for(const m of corpus.memories){
    if(m.project!==null&&!projects.has(m.project)) problems.push(`${m.id}: unknown project ${m.project}`);
    if(m.task!==null){
      const t=tasks.get(m.task);
      if(!t) problems.push(`${m.id}: unknown task ${m.task}`);
      else if(t.project!==m.project) problems.push(`${m.id}: scope disagrees with task ${m.task}`);
    }
  }
  for(const t of corpus.tasks)
    if((t.status==='done')!==(t.closed_at!==null)) problems.push(`task ${t.slug}: closed_at disagrees with status`);
  // A supersession that points nowhere, or at itself, silently stops being a
  // test of anything.
  for(const m of corpus.memories){
    if(!m.supersedes) continue;
    if(!memoryById.has(m.supersedes)) problems.push(`${m.id}: supersedes unknown memory ${m.supersedes}`);
    if(m.supersedes===m.id) problems.push(`${m.id}: supersedes itself`);
  }

  const pseen=new Set();
  for(const p of corpus.prompts){
    if(!/^p\d{3}$/.test(p.id)) problems.push(`prompt id malformed: ${p.id}`);
    if(pseen.has(p.id)) problems.push(`duplicate prompt id: ${p.id}`);
    pseen.add(p.id);
    if(!p.text?.trim()) problems.push(`${p.id}: empty text`);
  }
  // Every prompt must be labelled. An unlabelled prompt silently counts as
  // answerless and quietly corrupts the floor measurement, which is the one
  // number this corpus exists to produce.
  for(const p of corpus.prompts)
    if(!labels[p.id]) problems.push(`${p.id} is unlabelled, so it would be scored as having no answer`);
  for(const [pid,v] of Object.entries(labels)){
    if(!promptById.has(pid)) problems.push(`label for unknown prompt ${pid}`);
    for(const g of ['2','1']) for(const id of v[g]??[])
      if(!memoryById.has(id)) problems.push(`${pid} grade-${g} points at unknown memory ${id}`);
    const both=(v['2']??[]).filter(x=>(v['1']??[]).includes(x));
    if(both.length) problems.push(`${pid}: ${both[0]} is in both grade lists`);
  }
  if(problems.length) throw new Error(`corpus integrity:\n  ${problems.slice(0,20).join('\n  ')}`
    +(problems.length>20?`\n  ...and ${problems.length-20} more`:''));
  return {memories:corpus.memories.length,prompts:corpus.prompts.length,
    edgeCases:corpus.memories.filter(m=>m.edge_case).length,
    answerable:answerable.length,answerless:answerless.length,
    grade2:Object.values(labels).reduce((a,v)=>a+v['2'].length,0),
    grade1:Object.values(labels).reduce((a,v)=>a+v['1'].length,0)};
}

/** Prompt ids grouped by category, for seeing where a change actually landed. */
export function slices(){
  const out=new Map();
  for(const p of corpus.prompts){
    const key=p.category??'original';
    if(!out.has(key)) out.set(key,[]);
    out.get(key).push(p.id);
  }
  out.set('ALL answerable',answerable);
  out.set('ALL answerless',answerless);
  return out;
}
