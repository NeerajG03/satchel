// The one fact about the workspace Satchel reads: its GitHub origin.
//
// Not the files, not the branch, not the path. A normalized `owner/name` is
// enough to resolve which project this conversation is in, because
// project_repositories maps it server side. Anything more would be reading the
// person's code to decide where to file a sentence they said.
import {execFileSync} from 'node:child_process';

/** `owner/name`, lowercased, or null. Non-Git and non-GitHub workspaces are not
 *  an error: they simply have no repository, and memory stays personal until
 *  someone selects a project by hand. */
export function repositoryFrom(cwd) {
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd, encoding: 'utf8', timeout: 1000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    let repository = null;
    const scp = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (scp) repository = scp[1];
    else {
      const url = new URL(remote);
      if (url.hostname.toLowerCase() === 'github.com')
        repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    }
    repository = repository?.toLowerCase() ?? null;
    return repository && repository.length <= 201 && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)
      ? repository : null;
  } catch { return null; }
}

/** Hook input arrives on stdin as one JSON object. Bounded, because a hook that
 *  reads an unbounded stream is a hook that can be made to hang the session. */
export async function readHookInput(stream = process.stdin, limit = 65536) {
  let input = '';
  for await (const chunk of stream) {
    input += chunk;
    if (input.length > limit) return null;
  }
  try { return JSON.parse(input); } catch { return null; }
}

export const sessionIdOf = event =>
  typeof event?.session_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(event.session_id)
    ? event.session_id : null;

export const cwdOf = event =>
  typeof event?.cwd === 'string' && event.cwd.length <= 4096 ? event.cwd : process.cwd();

/** Hook output. Both hosts read additionalContext from stdout on the events
 *  that accept it, and systemMessage is what the person sees in their own
 *  terminal. Written in one place so a hook can never emit JSON we did not
 *  shape: everything that could become an instruction goes through here. */
export function emit({event, context = '', notice = ''} = {}) {
  const payload = {};
  if (event) payload.hookSpecificOutput = {hookEventName: event, additionalContext: context};
  if (notice) payload.systemMessage = notice;
  if (Object.keys(payload).length) process.stdout.write(JSON.stringify(payload));
}
