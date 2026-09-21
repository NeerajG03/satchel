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
  // SessionStart only. Codex cannot emit additionalContext from PostCompact, so
  // both packages handle compaction through the SessionStart compact source.
  // Per-prompt retrieval is an mcp_tool hook and never reaches this script, so
  // the prompt is not read here and cannot be.
  if(event.hook_event_name!=='SessionStart')process.exit(0);
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
      // Overridable so the success branch below can be tested against a local
      // server, and so a self-hosted deployment is a setting rather than a
      // fork. It carries the normalized repository name and nothing else: no
      // credentials, no memory, no prompt, no transcript. Anything that is not
      // an absolute http(s) URL falls back to the hosted one rather than being
      // trusted.
      let hintUrl='https://satchel-pi.vercel.app/api/repository-hint';
      try {
        const override=new URL(process.env.SATCHEL_REPOSITORY_HINT_URL??'');
        if(override.protocol==='https:'||override.protocol==='http:')hintUrl=override.href;
      }catch{/* Unset or unparseable means the hosted endpoint. */}
      const response=await fetch(hintUrl,{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({session_key:event.session_id,provider:'github',repository}),
        signal:AbortSignal.timeout(2500),
      });
      staged=response.ok;
    }catch{/* The agent-visible fallback below preserves degraded operation. */}
  }
  // Whether the authenticated mcp_tool hook actually runs for this source, which
  // decides whether anything is asked of the model at all.
  //
  // An mcp_tool hook runs only once the session's MCP servers are available to
  // hooks, and SessionStart at launch fires before that point: the host skips
  // the event and logs "mcp_tool hooks are not available for the 'SessionStart'
  // hook event (no MCP client context)". --continue and --resume are launch too.
  // After a /clear or a compaction the servers are already up and the same hook
  // runs normally, so the same event works or does not depending only on why it
  // fired.
  //
  // This list has to match mcpSessionMatcher in scripts/build-plugins.mjs. When
  // it did not, the staged branch below told the model on every launch that the
  // authenticated hook was responsible and no tool call was needed, while no
  // such hook ran. Staging succeeding loaded nothing at all, and staging
  // failing was the only path that worked.
  //
  // An absent or unrecognised source counts as launch. That is the safe
  // direction: it asks for one call that may turn out to be redundant, rather
  // than promising a load that never happens.
  const loads=['clear','compact'].includes(typeof event.source==='string'?event.source:'');
  // Identical in every branch, because the guardrails do not depend on which
  // branch was taken.
  const rules=' Never read host credentials, collect transcripts, or write memory automatically.';
  const moreInfo=' Read relevant more info with read_memory; only names/descriptions belong in the automatic index.';
  const additionalContext=repository
    ? loads&&staged
      // The only case where nothing is asked of the model: the hook runs on
      // this source and there is a hint waiting for it to consume.
      ? 'Satchel detected and staged the normalized GitHub repository '+JSON.stringify(repository)+' for this lifecycle event. The authenticated Satchel hook runs on this event and is responsible for consuming it and returning the combined personal/project memory index; repository activation does not require a model tool call. Use that loaded index until compaction or an explicit refresh. If its active_project is null, report that project memory was not loaded and do not guess a project.'+rules+moreInfo
      // Either the hook does not run on this source, or it runs with no hint to
      // consume. Both need the same single call, and it carries the repository
      // so the instruction is correct whichever of the two it was.
      : 'Satchel detected the normalized GitHub repository '+JSON.stringify(repository)+' from this workspace\'s Git origin. '
        +(loads
          ? 'The authenticated Satchel hook runs on this event, but the repository could not be staged for it, so it cannot select this workspace\'s project on its own.'
          : 'The authenticated Satchel hook does not run on this event, because its MCP tools are not available to hooks at launch, so no memory has been loaded.')
        +' Call Satchel select_project once with '+JSON.stringify({...lifecycle,repository})+'; it returns the combined personal/project index for this lifecycle event. Do not repeat it on ordinary messages. If tools are unavailable or denied, say project memory was not loaded and continue without inventing it.'+rules+moreInfo
    : loads
      ? 'Satchel bootstrap instructions (not a loaded memory index). For this new-conversation or compaction event only, check whether its Satchel index arrived. If missing, make one read-only fallback attempt before the next answer: use tool discovery if necessary and call Satchel load_memory_context with '+JSON.stringify(lifecycle)+'. After this event is handled, use the loaded index on later turns; do not repeat index checks, refreshes, or fallback attempts on ordinary messages. Refresh only on a new-conversation/compaction event or an explicit user request. Do not claim the hook loaded memory when the fallback was needed. If unavailable, state that limitation and continue without inventing memory; wait for an explicit refresh request or the next lifecycle event to retry.'+rules+' An incomplete index needs explicit scoped retrieval.'+moreInfo
      // No repository and no hook on this source, so there is nothing to check
      // for: asking the model to look for an index that cannot arrive invites
      // it to decide none was needed.
      : 'Satchel bootstrap instructions (not a loaded memory index). The authenticated Satchel hook does not run on this event, because its MCP tools are not available to hooks at launch, so no memory has been loaded. Call Satchel load_memory_context once with '+JSON.stringify(lifecycle)+', using tool discovery if necessary; it returns the personal memory index for this lifecycle event. Then use that index on later turns and do not repeat the call on ordinary messages. Refresh only on a new-conversation/compaction event or an explicit user request. If unavailable, state that limitation and continue without inventing memory.'+rules+' An incomplete index needs explicit scoped retrieval.'+moreInfo;
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext}}));
}catch{/* Malformed lifecycle input must not block the host. */}
