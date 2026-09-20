import {mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const name='satchel';
const description='Personal and project memory, tasks and projects across your agents.';
// Memory v2 is what both packages now carry: retrieval on every prompt and
// capture at the end of a turn.
const versions={claude:'0.2.0',codex:'0.2.0'};
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
  // mcp_tool input strings take ${path} substitution from the hook's own JSON
  // input on both hosts. The prompt field is the one name that differs: Claude
  // calls it user_prompt, Codex calls it prompt.
  const server=host==='claude'?'plugin:satchel:satchel':'satchel';
  // Both spellings are sent. Codex documents `prompt`; Claude's published
  // reference is truncated at this event, and the one working example in the
  // wild (the supermemory plugin) reads `prompt` with no fallback while a
  // summary of the same docs says `user_prompt`. An unsubstituted placeholder
  // arrives as its own literal text, which the server discards, so sending
  // both costs nothing and survives either answer.
  const promptFields={prompt:'${prompt}',user_prompt:'${user_prompt}'};
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
      input:{session_key:'${session_id}',event:'UserPromptSubmit',...promptFields},
      timeout:5,...(host==='codex'?{additionalContextLimit:2000}:{})}]}],
    // Capture. Without this the router, the rolling window and every capture
    // path exist and nothing ever calls them, which is how the whole feature
    // shipped inert the first time.
    //
    // An mcp_tool and not a command, even though the build plan first said
    // command: that reasoning assumed the rolling window lived on disk and
    // had to be read before calling anything. It lives in the database now,
    // so nothing local is needed and nothing proprietary leaves the server.
    //
    // Nothing is injected here. Claude Code can inject from Stop and Codex
    // cannot, so a design that used it would work on one host only, and the
    // next turn may change subject anyway.
    //
    // last_assistant_message exists on Claude and not on Codex, where the
    // placeholder arrives unsubstituted and the server discards it. The Codex
    // router therefore reads the user's messages without the replies, which
    // is a stated degradation rather than a bug to chase.
    Stop:[{hooks:[{type:'mcp_tool',server,tool:'load_memory_context',
      input:{session_key:'${session_id}',event:'Stop',
        last_assistant_message:'${last_assistant_message}'},
      timeout:10}]}],
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
