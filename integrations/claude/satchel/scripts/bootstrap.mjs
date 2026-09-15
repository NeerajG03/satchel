import {execFileSync} from 'node:child_process';

// Reads only the current workspace's Git origin. No network, credentials,
// transcript access or writes. Remote credentials are never emitted.
let input='';
for await (const chunk of process.stdin) {
  input+=chunk;
  if(input.length>65536)process.exit(0);
}
try {
  const event=JSON.parse(input);
  if(typeof event.session_id!=='string'||!/^[a-z0-9_-]{1,200}$/i.test(event.session_id))process.exit(0);
  if(!['SessionStart','PostCompact'].includes(event.hook_event_name))process.exit(0);
  let repository=null;
  try {
    const cwd=typeof event.cwd==='string'&&event.cwd.length<=4096?event.cwd:process.cwd();
    const remote=execFileSync('git',['config','--get','remote.origin.url'],{
      cwd,encoding:'utf8',timeout:1000,maxBuffer:4096,stdio:['ignore','pipe','ignore'],
    }).trim();
    const scp=remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
    if(scp)repository=scp[1];
    else {
      const url=new URL(remote);
      if(url.hostname.toLowerCase()==='github.com')repository=url.pathname.replace(/^\/+|\/+$/g,'').replace(/\.git$/i,'');
    }
    repository=repository?.toLowerCase()??null;
    if(!repository||repository.length>201||!repository.match(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/))repository=null;
  }catch{/* Non-Git and unlinked workspaces retain personal/manual behavior. */}
  const lifecycle={session_key:event.session_id,event:event.hook_event_name};
  const additionalContext=repository
    ? 'Satchel detected the normalized GitHub repository '+JSON.stringify(repository)+' from this workspace\'s Git origin. For this new-conversation or compaction event, use tool discovery if necessary and call Satchel activate_repository with '+JSON.stringify({...lifecycle,provider:'github',repository})+'. Do this once even if a personal-only Satchel index also arrived: activation selects only an already-authorized linked project for this conversation and returns the combined personal/project index. Never guess a repository from folder names or repository content. If activation is unavailable or denied, say project memory was not loaded and continue without inventing it. After this event, use the returned index until compaction or an explicit refresh. Never read host credentials, collect transcripts, or write memory automatically. Read relevant more info with read_memory; only names/descriptions belong in the automatic index.'
    : 'Satchel bootstrap instructions (not a loaded memory index). For this new-conversation or compaction event only, check whether its Satchel index arrived. If missing, make one read-only fallback attempt before the next answer: use tool discovery if necessary and call Satchel load_memory_context with '+JSON.stringify(lifecycle)+'. After this event is handled, use the loaded index on later turns; do not repeat index checks, refreshes, or fallback attempts on ordinary messages. Refresh only on a new-conversation/compaction event or an explicit user request. Do not claim the hook loaded memory when the fallback was needed. If unavailable, state that limitation and continue without inventing memory; wait for an explicit refresh request or the next lifecycle event to retry. Never read host credentials, collect transcripts, or write memory automatically. An incomplete index needs explicit scoped retrieval. Use read_memory for relevant more info; only names/descriptions belong in the automatic index.';
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext}}));
}catch{/* Malformed lifecycle input must not block the host. */}
