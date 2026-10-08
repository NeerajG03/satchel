import {mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const name='satchel';
const description='Personal and topic memory, tasks and topics across your agents.';
// 0.3.0 is the hooks-as-scripts release. Every hook is a command now, holding
// its own OAuth credential, so none of them depend on the host's MCP client
// being up. That is what makes memory arrive at launch instead of only after a
// /clear.
//
// 0.3.1 fixes the connect window: fifteen minutes rather than three, and a
// missed one is retried instead of turning into an hour of "run this command".
//
// 0.3.2 puts per-prompt retrieval back and stops reading the transcript. Both
// came from one wrong belief: that a command hook is not handed the prompt.
//
// 0.4.8 widens the retrieve hook's timeout from 5s to 10s (and its inner
// fetch from 4s to 8s), because a stale token needs a refresh before the
// retrieval call and that alone could take longer than 5s, discarding the
// hook's output. A patch, not the fix: the real work is making the common
// path fast rather than widening the timeout further.
//
// 0.4.9 is that work: session-start.mjs now refreshes a token that is within
// ten minutes of expiring, in the SessionStart hook's own budget, so a token a
// session is about to outlive gets renewed at startup, clear, compact or
// resume rather than being discovered expired by a UserPromptSubmit hook with
// far less room to spend on a refresh.
//
// 0.5.0 says topic where it said project: the MCP tools are list_topics,
// upsert_topic and select_topic, every tool field is topic_id, and the shipped
// skill reads the same way. Minor, not a patch, because an agent following the
// old skill would call tools that no longer exist.
const versions={claude:'0.5.0',codex:'0.5.0'};
for(const host of ['codex','claude']) {
  const target=join(root,'integrations',host,name);
  await mkdir(join(target,`.${host}-plugin`),{recursive:true});
  await mkdir(join(target,'hooks'),{recursive:true});
  await mkdir(join(target,'scripts'),{recursive:true});
  // Every hook script, plus the two modules they share. They are copied rather
  // than bundled because the plugin is read by people deciding whether to trust
  // it, and one readable file per job is the point.
  for(const script of ['session-start.mjs','retrieve.mjs','capture.mjs','connect.mjs',
    'auth.mjs','workspace.mjs','background.mjs'])
    await cp(join(root,'integrations/shared',script),join(target,'scripts',script));
  const common={name,version:versions[host],description,author:{name:'Satchel'},repository:'https://github.com/NeerajG03/satchel'};
  const manifest=host==='codex'?{...common,skills:'./skills/',mcpServers:'./.mcp.json',interface:{
    displayName:'Satchel',shortDescription:'Your memory, tasks and topics, across your agents.',
    longDescription:'Load memory and task summaries automatically, read details on demand, and explicitly save or revise memories, tasks and topics with scoped access.',
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
  const pluginRoot=host==='codex'?'PLUGIN_ROOT':'CLAUDE_PLUGIN_ROOT';
  // Both hosts take the same shape here, and ${PLUGIN_ROOT} is the only thing
  // that differs. Timeouts are explicit: a hook with no timeout that cannot
  // reach the network is a session that will not open.
  const script=(name,timeout)=>({hooks:[{type:'command',
    command:`node "\${${pluginRoot}}/scripts/${name}"`,timeout}]});
  // resume is included. It was excluded when this was an mcp_tool hook that
  // could not run at launch anyway; a resumed session may be days old and is
  // the case that needs the topics list most.
  //
  // Codex has no working PostCompact: it cannot emit additionalContext there,
  // so compaction is handled by its own SessionStart compact source instead.
  const sessionMatcher='^(startup|clear|compact|resume)$';
  await writeFile(join(target,'hooks','hooks.json'),JSON.stringify({hooks:{
    // One script, every source. Until 0.3.0 this was two handlers: a command
    // that could only stage a repository name, and an mcp_tool that fetched the
    // memory but was skipped at launch, because mcp_tool hooks need the
    // session's MCP servers to already be up and SessionStart fires before
    // that. Launch, --continue and --resume therefore loaded nothing at all,
    // and what the agent got instead was a paragraph asking it to please call
    // select_project (now select_topic), which it was free to ignore.
    //
    // The script authenticates for itself, so there is no such event now.
    SessionStart:[{...script('session-start.mjs',10),matcher:sessionMatcher}],
    // Capture. Without this the router, the rolling window and every capture
    // path exist and nothing ever calls them, which is how the whole feature
    // shipped inert the first time.
    //
    // Nothing is injected here. Claude can inject from Stop and Codex cannot,
    // so a design that used it would work on one host only, and the next turn
    // may change the subject anyway.
    //
    // 20 seconds because this one waits on a model call. It is the end of a
    // turn, so the person is reading the answer rather than waiting on a
    // prompt, which is the one place in the session that can afford it.
    Stop:[script('capture.mjs',25)],
    // Retrieval, and the only thing that records what the person said. Those
    // two jobs are in one hook because the second is free once the first has
    // the prompt, and separating them once meant deleting retrieval silently
    // took capture with it.
    //
    // A command hook IS handed the prompt: the host builds the input as
    // {…, hook_event_name:"UserPromptSubmit", prompt, session_title}. A docs
    // summary said otherwise, this was deleted on the strength of it, and the
    // binary settled it. Do not remove it again without checking that first.
    //
    // Was 5 seconds on purpose, on the same reasoning: a hook that delays the
    // prompt is worse than a hook that misses one. But 5s did not leave room
    // for the one case that actually needs it — a token refresh before the
    // retrieval call, which alone can take longer than that (see auth.mjs's
    // withLock and refresh). That turned "misses one" into "misses most of
    // them, every time the token happens to be stale." 10s instead, patched
    // for now; the real fix is making the common path fast rather than
    // widening the timeout further.
    UserPromptSubmit:[script('retrieve.mjs',10)],
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
  description:'The Satchel plugin for Claude Code: your memory, tasks and topics across your agents.',
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
