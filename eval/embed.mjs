// Caches embeddings keyed by stable id, and only embeds what is missing, so a
// corpus that grows costs one call per new row rather than a full rebuild.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {corpus} from './lib/data.mjs';

const HOST=process.env.OLLAMA_HOST??'http://127.0.0.1:11434';
const dir=new URL('./embeddings/',import.meta.url);
mkdirSync(dir,{recursive:true});

// name -> {model, textOf, provider, dimensions}
// Local models run through ollama; anything hosted goes through OpenRouter's
// OpenAI-compatible endpoint, which is the same shape server/embedding.mjs uses.
const INDEXES={
  'all-minilm/statement':   {model:'all-minilm',       textOf:m=>m.statement},
  'nomic/statement':        {model:'nomic-embed-text', textOf:m=>m.statement},
  'nomic/statement+source': {model:'nomic-embed-text', textOf:m=>`${m.statement} ${m.source}`},
  'nemotron-768/statement+source': {provider:'openrouter',
    model:'nvidia/llama-nemotron-embed-vl-1b-v2:free', dimensions:768,
    textOf:m=>`${m.statement} ${m.source}`},
  'nemotron3-2048/statement+source': {provider:'openrouter',
    model:'nvidia/nemotron-3-embed-1b:free', dimensions:2048,
    textOf:m=>`${m.statement} ${m.source}`},
  'nemotron-2048/statement+source': {provider:'openrouter',
    model:'nvidia/llama-nemotron-embed-vl-1b-v2:free', dimensions:2048,
    textOf:m=>`${m.statement} ${m.source}`},
};

async function embed(spec,texts){
  const {model,provider='ollama',dimensions}=spec;
  const out=[];
  for(let i=0;i<texts.length;i+=64){
    const batch=texts.slice(i,i+64);
    const r=provider==='openrouter'
      ? await fetch('https://openrouter.ai/api/v1/embeddings',{method:'POST',
          headers:{'content-type':'application/json',
            authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`},
          body:JSON.stringify({model,input:batch,...(dimensions?{dimensions}:{})})})
      : await fetch(`${HOST}/api/embed`,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({model,input:batch})});
    // OpenRouter's free models allow 20 requests a minute per account. A
    // backfill is exactly the shape that hits it, so wait and retry rather than
    // losing the batch.
    if(r.status===429){
      const reset=Number(r.headers.get('x-ratelimit-reset'))||0;
      const waitMs=Math.min(Math.max(reset-Date.now(),4000),65000);
      process.stdout.write(`\r    rate limited, waiting ${Math.round(waitMs/1000)}s   `);
      await new Promise(done=>setTimeout(done,waitMs));
      i-=64;
      continue;
    }
    if(!r.ok) throw new Error(`${model}: ${r.status} ${(await r.text()).slice(0,200)}`);
    const payload=await r.json();
    const vectors=provider==='openrouter'?payload.data.map(d=>d.embedding):payload.embeddings;
    out.push(...vectors);
    process.stdout.write(`\r    ${out.length}/${texts.length}   `);
  }
  if(texts.length) process.stdout.write('\r');
  return out;
}

const only=process.argv.slice(2);
for(const [name,spec] of Object.entries(INDEXES)){
  if(only.length&&!only.includes(name)) continue;
  const {model,textOf}=spec;
  if(spec.provider==='openrouter'&&!process.env.OPENROUTER_API_KEY){
    console.log(`  ${name}: skipped, no OPENROUTER_API_KEY`); continue;
  }
  const file=new URL(`./${name.replace(/[/+]/g,'_')}.json`,dir);
  const cache=existsSync(file)?JSON.parse(readFileSync(file,'utf8'))
    :{name,model,dims:0,memories:{},prompts:{}};
  const newMem=corpus.memories.filter(m=>!cache.memories[m.id]);
  const newPro=corpus.prompts.filter(p=>!cache.prompts[p.id]);
  if(!newMem.length&&!newPro.length){console.log(`  ${name}: up to date`);continue;}
  const t=Date.now();
  if(newMem.length){
    const v=await embed(spec,newMem.map(textOf));
    newMem.forEach((m,i)=>cache.memories[m.id]=v[i]);
    cache.dims=v[0].length;
  }
  if(newPro.length){
    const v=await embed(spec,newPro.map(p=>p.text));
    newPro.forEach((p,i)=>cache.prompts[p.id]=v[i]);
    cache.dims||=v[0].length;
  }
  writeFileSync(file,JSON.stringify(cache));
  const n=newMem.length+newPro.length;
  console.log(`  ${name}: +${n} texts, ${cache.dims} dims, ${((Date.now()-t)/1000).toFixed(1)}s `
    +`(${((Date.now()-t)/n).toFixed(1)} ms each)`);
}
