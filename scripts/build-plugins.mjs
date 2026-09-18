import {mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const name='satchel';
const description='Personal and project memory, tasks and projects across your agents.';
const versions={claude:'0.1.6',codex:'0.1.4'};
for(const host of ['codex','claude']) {
  const target=join(root,'integrations',host,name);
  await mkdir(join(target,`.${host}-plugin`),{recursive:true});
  await mkdir(join(target,'hooks'),{recursive:true});
  await mkdir(join(target,'scripts'),{recursive:true});
  await cp(join(root,'integrations/shared/bootstrap.mjs'),join(target,'scripts/bootstrap.mjs'));
  const common={name,version:versions[host],description,author:{name:'Satchel'},repository:'https://github.com/NeerajG03/satchel'};
  const manifest=host==='codex'?{...common,skills:'./skills/',mcpServers:'./.mcp.json',interface:{
    displayName:'Satchel',shortDescription:'Your memory, tasks and projects, across your agents.',
    longDescription:'Load memory and task summaries automatically, read details on demand, and explicitly save or revise memories, tasks and projects with scoped access.',
    developerName:'Satchel',category:'Productivity',capabilities:['Read','Write'],defaultPrompt:'Use my Satchel context for this task.',
    websiteURL:'https://satchel-pi.vercel.app',brandColor:'#E4571E',logo:'./assets/logo.png',composerIcon:'./assets/icon.png',
  }}:common;
  if(host==='codex'){
    await mkdir(join(target,'assets'),{recursive:true});
    await cp(join(root,'design/mark/logo-512.png'),join(target,'assets/logo.png'));
    await cp(join(root,'design/mark/icon-256.png'),join(target,'assets/icon.png'));
  }
  await writeFile(join(target,`.${host}-plugin`,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
  const mcp={type:'http',url:'https://satchel-pi.vercel.app/api/mcp',
    ...(host==='codex'?{required:true,startup_timeout_sec:10}:{})};
  await writeFile(join(target,'.mcp.json'),JSON.stringify({mcpServers:{satchel:mcp}},null,2)+'\n');
  const makeHook=event=>[{hooks:[{type:'mcp_tool',server:host==='claude'?'plugin:satchel:satchel':'satchel',tool:'load_memory_context',input:{session_key:'${session_id}',event},timeout:10}]}];
  const pluginRoot=host==='codex'?'PLUGIN_ROOT':'CLAUDE_PLUGIN_ROOT';
  const bootstrap={hooks:[{type:'command',command:`node "\${${pluginRoot}}/scripts/bootstrap.mjs"`,timeout:5}]};
  const sessionHooks=makeHook('SessionStart');
  sessionHooks[0].matcher=host==='claude'?'^(clear|compact)$':'^(startup|clear)$';
  await writeFile(join(target,'hooks','hooks.json'),JSON.stringify({hooks:{
    SessionStart:[{...bootstrap,matcher:host==='claude'?'^(startup|clear|compact)$':'^(startup|clear)$'},...sessionHooks],
    ...(host==='codex'?{
      PostCompact:[bootstrap,...makeHook('PostCompact')],
    }:{}),
  }},null,2)+'\n');
  // The skill ships SKILL.md plus its progressively disclosed references, so copy the tree.
  await rm(join(target,'skills'),{recursive:true,force:true});
  await cp(join(root,'integrations/shared/context'),join(target,'skills','context'),{recursive:true});
}
// Optional explicit destination copies only this package, never marketplace config.
if(process.argv[2]) {
  const target=resolve(process.argv[2]);
  if(!target.endsWith('/satchel'))throw Error('Destination must be a satchel plugin directory');
  await cp(join(root,'integrations/codex/satchel'),target,{recursive:true});
}
await mkdir(join(root,'.claude-plugin'),{recursive:true});
await writeFile(join(root,'.claude-plugin/marketplace.json'),JSON.stringify({
  name:'satchel',
  description:'The Satchel plugin for Claude Code: your memory, tasks and projects across your agents.',
  owner:{name:'Satchel',url:'https://github.com/NeerajG03/satchel'},
  plugins:[{name,source:'./integrations/claude/satchel',description,version:versions.claude,category:'productivity'}],
},null,2)+'\n');
await mkdir(join(root,'.agents/plugins'),{recursive:true});
await writeFile(join(root,'.agents/plugins/marketplace.json'),JSON.stringify({
  name:'satchel',
  interface:{displayName:'Satchel'},
  plugins:[{name,source:{source:'local',path:'./integrations/codex/satchel'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}],
},null,2)+'\n');
console.log('Built Codex and Claude packages and the root marketplace files.');
