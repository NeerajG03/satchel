// Static guidance only: no network, credentials, transcript reads, or writes.
let input='';
for await (const chunk of process.stdin) {
  input+=chunk;
  if(input.length>65536)process.exit(0);
}
try {
  const event=JSON.parse(input);
  if(typeof event.session_id!=='string'||!/^[a-z0-9_-]{1,200}$/i.test(event.session_id))process.exit(0);
  if(!['SessionStart','UserPromptSubmit','PostCompact'].includes(event.hook_event_name))process.exit(0);
  const additionalContext='Satchel bootstrap instructions (not a loaded memory index). Before answering, check for a successful Satchel index from this turn. If it is missing, use tool discovery if necessary and call Satchel load_memory_context with '+JSON.stringify({session_key:event.session_id,event:event.hook_event_name})+'. This is a read-only fallback for MCP startup timing. Do not claim the hook loaded memory when the fallback was needed. If unavailable, state that limitation and continue without inventing memory. Never read host credentials, collect transcripts, or write memory automatically. An incomplete index needs explicit scoped retrieval. Use read_memory for relevant more info; only names/descriptions belong in the automatic index.';
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext}}));
}catch{/* Malformed lifecycle input must not block the host. */}
