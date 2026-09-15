import {execFileSync} from 'node:child_process';

// Reads only the current workspace's Git origin. It stages the normalized
// identity for the authenticated MCP lifecycle hook; no credentials, memory
// data, repository content or transcripts are read or emitted.
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
  let staged=false;
  if(repository&&process.env.SATCHEL_DISABLE_REPOSITORY_STAGING!=='1') {
    try {
      const response=await fetch('https://satchel-pi.vercel.app/api/repository-hint',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({session_key:event.session_id,provider:'github',repository}),
        signal:AbortSignal.timeout(2500),
      });
      staged=response.ok;
    }catch{/* The agent-visible fallback below preserves degraded operation. */}
  }
  const additionalContext=repository
    ? staged
      ? 'Satchel detected and staged the normalized GitHub repository '+JSON.stringify(repository)+' for this lifecycle event. The authenticated Satchel hook is responsible for consuming it and returning the combined personal/project memory index; repository activation does not require a model tool call. Use that loaded index until compaction or an explicit refresh. If its active_project is null, report that project memory was not loaded and do not guess a project. Never read host credentials, collect transcripts, or write memory automatically. Read relevant more info with read_memory; only names/descriptions belong in the automatic index.'
      : 'Satchel detected the normalized GitHub repository '+JSON.stringify(repository)+' from this workspace\'s Git origin, but could not stage it for the authenticated lifecycle hook. For this new-conversation or compaction event, call Satchel activate_repository once with '+JSON.stringify({...lifecycle,provider:'github',repository})+'. If tools are unavailable or denied, say project memory was not loaded and continue without inventing it. Never read host credentials, collect transcripts, or write memory automatically.'
    : 'Satchel bootstrap instructions (not a loaded memory index). For this new-conversation or compaction event only, check whether its Satchel index arrived. If missing, make one read-only fallback attempt before the next answer: use tool discovery if necessary and call Satchel load_memory_context with '+JSON.stringify(lifecycle)+'. After this event is handled, use the loaded index on later turns; do not repeat index checks, refreshes, or fallback attempts on ordinary messages. Refresh only on a new-conversation/compaction event or an explicit user request. Do not claim the hook loaded memory when the fallback was needed. If unavailable, state that limitation and continue without inventing memory; wait for an explicit refresh request or the next lifecycle event to retry. Never read host credentials, collect transcripts, or write memory automatically. An incomplete index needs explicit scoped retrieval. Use read_memory for relevant more info; only names/descriptions belong in the automatic index.';
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext}}));
}catch{/* Malformed lifecycle input must not block the host. */}
