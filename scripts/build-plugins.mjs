import {mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const name='satchel';
for(const host of ['codex','claude']) {
  const target=join(root,'integrations',host,name);
  await mkdir(join(target,`.${host}-plugin`),{recursive:true});
  await mkdir(join(target,'hooks'),{recursive:true});
  await mkdir(join(target,'scripts'),{recursive:true});
  await cp(join(root,'integrations/shared/bootstrap.mjs'),join(target,'scripts/bootstrap.mjs'));
  const common={name,version:host==='claude'?'0.2.0':'0.2.0',description:'Personal and project memory, tasks and projects across your agents.',author:{name:'Satchel'},repository:'https://github.com/NeerajG03/satchel'};
  const manifest=host==='codex'?{...common,skills:'./skills/',mcpServers:'./.mcp.json',interface:{
    displayName:'Satchel',shortDescription:'Your memory, tasks and projects, across your agents.',
    longDescription:'Load memory and task summaries automatically, read details on demand, and explicitly save or revise memories, tasks and projects with scoped access.',
    developerName:'Satchel',category:'Productivity',capabilities:['Read','Write'],defaultPrompt:'Use my Satchel context for this task.',
  }}:common;
  await writeFile(join(target,`.${host}-plugin`,'plugin.json'),JSON.stringify(manifest,null,2)+'\n');
  const mcp={type:'http',url:'https://satchel-pi.vercel.app/api/mcp',
    ...(host==='codex'?{required:true,startup_timeout_sec:10}:{})};
  await writeFile(join(target,'.mcp.json'),JSON.stringify({mcpServers:{satchel:mcp}},null,2)+'\n');
  // mcp_tool input strings take ${path} substitution from the hook's own JSON
  // input on both hosts. The prompt field is the one name that differs: Claude
  // calls it user_prompt, Codex calls it prompt.
  const server=host==='claude'?'plugin:satchel:satchel':'satchel';
  const promptField=host==='claude'?'${user_prompt}':'${prompt}';
  const lifecycleHook=event=>({hooks:[{type:'mcp_tool',server,tool:'load_memory_context',
    input:{session_key:'${session_id}',event},timeout:10,
    ...(host==='codex'?{additionalContextLimit:6000}:{})}]});
  const pluginRoot=host==='codex'?'PLUGIN_ROOT':'CLAUDE_PLUGIN_ROOT';
  const bootstrap={hooks:[{type:'command',command:`node "\${${pluginRoot}}/scripts/bootstrap.mjs"`,timeout:5}]};
  // resume is included now. It was excluded when a whole index loaded, because
  // that duplicated context onto a session that already had it. With retrieval
  // the session-start block is small and a resumed session may be days old, so
  // it is the case that needs the projects list most.
  //
  // Codex has no working PostCompact: it cannot emit additionalContext there,
  // so compaction is handled by its own SessionStart compact source instead.
  const sessionMatcher='^(startup|clear|compact|resume)$';
  await writeFile(join(target,'hooks','hooks.json'),JSON.stringify({hooks:{
    SessionStart:[{...bootstrap,matcher:sessionMatcher},{...lifecycleHook('SessionStart'),matcher:sessionMatcher}],
    // Retrieval runs here rather than being left to the model to request. A
    // short timeout on purpose: a hook that delays the prompt is worse than a
    // hook that misses one.
    UserPromptSubmit:[{hooks:[{type:'mcp_tool',server,tool:'load_memory_context',
      input:{session_key:'${session_id}',event:'UserPromptSubmit',prompt:promptField},
      timeout:5,...(host==='codex'?{additionalContextLimit:2000}:{})}]}],
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
console.log('Built Codex and Claude packages.');
