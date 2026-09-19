// Caches embeddings keyed by stable id, and only embeds what is missing, so a
// corpus that grows costs one call per new row rather than a full rebuild.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {corpus} from './lib/data.mjs';

const HOST=process.env.OLLAMA_HOST??'http://127.0.0.1:11434';
const dir=new URL('./embeddings/',import.meta.url);
mkdirSync(dir,{recursive:true});

// name -> [model, how a memory is turned into the text that gets indexed]
const INDEXES={
  'all-minilm/statement':        ['all-minilm',        m=>m.statement],
  'nomic/statement':             ['nomic-embed-text',  m=>m.statement],
  'nomic/statement+source':      ['nomic-embed-text',  m=>`${m.statement} ${m.source}`],
};

async function embed(model,texts){
  const out=[];
  for(let i=0;i<texts.length;i+=64){
    const r=await fetch(`${HOST}/api/embed`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model,input:texts.slice(i,i+64)})});
    if(!r.ok) throw new Error(`${model}: ${r.status} ${await r.text()}`);
    out.push(...(await r.json()).embeddings);
    process.stdout.write(`\r    ${out.length}/${texts.length}   `);
  }
  if(texts.length) process.stdout.write('\r');
  return out;
}

const only=process.argv.slice(2);
for(const [name,[model,textOf]] of Object.entries(INDEXES)){
  if(only.length&&!only.includes(name)) continue;
  const file=new URL(`./${name.replace(/[/+]/g,'_')}.json`,dir);
  const cache=existsSync(file)?JSON.parse(readFileSync(file,'utf8'))
    :{name,model,dims:0,memories:{},prompts:{}};
  const newMem=corpus.memories.filter(m=>!cache.memories[m.id]);
  const newPro=corpus.prompts.filter(p=>!cache.prompts[p.id]);
  if(!newMem.length&&!newPro.length){console.log(`  ${name}: up to date`);continue;}
  const t=Date.now();
  if(newMem.length){
    const v=await embed(model,newMem.map(textOf));
    newMem.forEach((m,i)=>cache.memories[m.id]=v[i]);
    cache.dims=v[0].length;
  }
  if(newPro.length){
    const v=await embed(model,newPro.map(p=>p.text));
    newPro.forEach((p,i)=>cache.prompts[p.id]=v[i]);
    cache.dims||=v[0].length;
  }
  writeFileSync(file,JSON.stringify(cache));
  const n=newMem.length+newPro.length;
  console.log(`  ${name}: +${n} texts, ${cache.dims} dims, ${((Date.now()-t)/1000).toFixed(1)}s `
    +`(${((Date.now()-t)/n).toFixed(1)} ms each)`);
}
