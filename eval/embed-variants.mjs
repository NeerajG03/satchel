// Variant indexings of the same corpus, to test what should be embedded.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const HOST=process.env.OLLAMA_HOST??'http://127.0.0.1:11434';
const corpus=JSON.parse(readFileSync(new URL('./corpus.json',import.meta.url),'utf8'));
async function embed(model,inputs){
  const out=[];
  for(let i=0;i<inputs.length;i+=64){
    const r=await fetch(`${HOST}/api/embed`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model,input:inputs.slice(i,i+64)})});
    if(!r.ok) throw new Error(await r.text());
    out.push(...(await r.json()).embeddings);
  }
  return out;
}
const variants={
  'statement':        m=>m.statement,
  'statement+source': m=>`${m.statement} ${m.source}`,
  'scoped':           m=>`${m.project??'personal'}: ${m.statement}`,
};
for(const model of ['nomic-embed-text']){
  for(const [name,fn] of Object.entries(variants)){
    const f=new URL(`./embeddings/${model}__${name.replace(/[+ ]/g,'_')}.json`,import.meta.url);
    if(existsSync(f)){console.log(`  ${name}: cached`);continue;}
    const memories=await embed(model,corpus.memories.map(fn));
    const prompts=await embed(model,corpus.prompts.map(p=>p.text));
    writeFileSync(f,JSON.stringify({model:`${model}/${name}`,dims:memories[0].length,memories,prompts}));
    console.log(`  ${name}: done`);
  }
}
