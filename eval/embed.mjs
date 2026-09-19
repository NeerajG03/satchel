// Embeds the corpus once per model and caches to eval/embeddings/<model>.json
// Requires a local ollama. Nothing leaves the machine.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
const HOST=process.env.OLLAMA_HOST??'http://127.0.0.1:11434';
const corpus=JSON.parse(readFileSync(new URL('./corpus.json',import.meta.url),'utf8'));
const dir=new URL('./embeddings/',import.meta.url);
mkdirSync(dir,{recursive:true});

async function embed(model,inputs){
  const out=[];
  for(let i=0;i<inputs.length;i+=64){
    const batch=inputs.slice(i,i+64);
    const r=await fetch(`${HOST}/api/embed`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model,input:batch})});
    if(!r.ok) throw new Error(`${model}: ${r.status} ${await r.text()}`);
    const j=await r.json();
    if(!j.embeddings?.length) throw new Error(`${model}: no embeddings returned`);
    out.push(...j.embeddings);
    process.stdout.write(`\r  ${model}: ${out.length}/${inputs.length}   `);
  }
  process.stdout.write('\n');
  return out;
}

for(const model of (process.argv.slice(2).length?process.argv.slice(2):['all-minilm','nomic-embed-text'])){
  const file=new URL(`./embeddings/${model.replace(/[:/]/g,'_')}.json`,import.meta.url);
  if(existsSync(file)){console.log(`  ${model}: cached`);continue;}
  const t=Date.now();
  const memories=await embed(model,corpus.memories.map(m=>m.statement));
  const prompts=await embed(model,corpus.prompts.map(p=>p.text));
  writeFileSync(file,JSON.stringify({model,dims:memories[0].length,memories,prompts}));
  console.log(`  ${model}: ${memories[0].length} dims, ${((Date.now()-t)/1000).toFixed(1)}s total`);
}
