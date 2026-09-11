import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const name='satchel';
for(const host of ['codex','claude']) {
  const target=join(root,'integrations',host,name);
  await mkdir(join(target,`.${host}-plugin`),{recursive:true});
  await mkdir(join(target,'hooks'),{recursive:true});
  await mkdir(join(target,'skills','memory'),{recursive:true});
  await mkdir(join(target,'scripts'),{recursive:true});
  await cp(join(root,'integrations/shared/bootstrap.mjs'),join(target,'scripts/bootstrap.mjs'));
  const common={name,version:'0.1.0',description:'Personal and project memory across your agents.',author:{name:'Satchel'},repository:'https://github.com/NeerajG03/satchel'};
  const manifest=host==='codex'?{...common,skills:'./skills/',mcpServers:'./.mcp.json',interface:{
    displayName:'Satchel',shortDescription:'Your memory, across your agents.',
    longDescription:'Load memory summaries automatically, read details on demand, and explicitly save or revise memories with scoped access.',
    developerName:'Satchel',category:'Productivity',capabilities:['Read','Write'],defaultPrompt:'Use my Satchel memory for this task.',
  }}:common;
  await writeFile(join(target,`.${host}-plugin`,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(join(target,'.mcp.json'),JSON.stringify({mcpServers:{satchel:{type:'http',url:'https://satchel-pi.vercel.app/api/mcp'}}},null,2)+'\n');
  const makeHook=event=>[{hooks:[{type:'mcp_tool',server:host==='claude'?'plugin:satchel:satchel':'satchel',tool:'load_memory_context',input:{session_key:'${session_id}',event},timeout:10}]}];
  const bootstrap={hooks:[{type:'command',command:'node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs"',timeout:5}]};
  const sessionHooks=makeHook('SessionStart');
  if(host==='claude')sessionHooks[0].matcher='clear|compact';
  await writeFile(join(target,'hooks','hooks.json'),JSON.stringify({hooks:{
    UserPromptSubmit:[bootstrap,...makeHook('UserPromptSubmit')],
    SessionStart:[bootstrap,...sessionHooks],
    ...(host==='codex'?{PostCompact:[bootstrap,...makeHook('PostCompact')]}:{}),
  }},null,2)+'\n');
  await writeFile(join(target,'skills','memory','SKILL.md'),await readFile(join(root,'integrations/shared/memory/SKILL.md')));
}
// Optional explicit destination copies only this package, never marketplace config.
if(process.argv[2]) {
  const target=resolve(process.argv[2]);
  if(!target.endsWith('/satchel'))throw Error('Destination must be a satchel plugin directory');
  await cp(join(root,'integrations/codex/satchel'),target,{recursive:true});
}
console.log('Built Codex and Claude packages.');
