// What a session start injects, and what the end of a turn captures.
//
// This used to live inside createMemoryServer, reachable only as the
// load_memory_context MCP tool. That tool is gone: hooks are command scripts
// now, holding their own OAuth credential, so they call an HTTP endpoint
// instead of asking the host to make a tool call on their behalf. The logic
// did not change, so it moved here rather than being rewritten, and
// select_project still uses it for the manual recovery path.
//
// Two entry points and nothing else:
//
//   sessionStart   projects + every personal memory, once per session
//   capture        the turn that just ended, classified, maybe saved
//
// Per-prompt retrieval used to sit between them. It is gone. A command hook on
// UserPromptSubmit is not given the prompt text, and the only documented way to
// get it is to read the transcript file while the host is still writing it,
// which is a race for a feature that was injecting on every single turn.
// Session start carries the memory now, and retrieve_memory is there when the
// agent actually wants something.
import {sessionStartBlock, estimateTokens, noticeFor} from './injection-format.mjs';
import {errorText} from './error-text.mjs';

const PROVIDER = 'github';

// Tracing is passed in, not imported. tracing.mjs pulls in `ai`, the
// OpenTelemetry node SDK and three Langfuse packages, and /api/hook-index runs
// on every session start with a hook timeout over it. Importing it here would
// put that endpoint back on the 709ms cold start that identity.mjs exists to
// avoid, for a span on a read that memory_injections already records.
//
// So capture is traced, because that is where the model call, the cost and the
// mistakes are, and session start is not.
const untraced = (_name, _options, run) => run(() => {}, () => {});

/** The scope this conversation is in.
 *
 *  Deterministic whenever it can be. An explicit select_project wins, then the
 *  workspace's git remote through project_repositories. No model is asked to
 *  guess, which is what put a memory about this project's own deployment key
 *  into personal scope.
 *
 *  A repository may name more than one project, because a project is a
 *  collection of context and a monorepo holds several of them. When it does,
 *  nothing is selected and the candidates come back instead. */
export async function resolveScope(service, {sessionKey, repository}) {
  const active = await service.activeProject(sessionKey);
  if (active) return {project: active, candidates: []};
  if (!repository) return {project: null, candidates: []};
  const rows = await service.resolveRepository(sessionKey, PROVIDER, repository);
  const selected = rows.find(row => row.selected);
  return {project: selected?.project_id ?? null, candidates: selected ? [] : rows};
}

/** What the agent is told when its workspace could be either of two projects.
 *  Named by slug, chosen by project_id, because the id is what select_project
 *  takes and a slug it had to look up is a second place to go wrong. */
const chooseProjectLine = candidates => candidates.length < 2 ? ''
  : `\nThis workspace's repository belongs to ${candidates.length} projects: `
    + candidates.map(c => `${c.slug} (${c.project_id})`).join(', ')
    + `. Nothing is scoped to a project until you call select_project with one of those project_id values.`
    + ` Do not guess, and do not treat memory as project-scoped before then.`;

/** Session start, after compaction, and after a clear.
 *
 *  Only what applies no matter what you do today: the projects that exist, and
 *  every personal memory. Anything scoped to a project is earned by asking for
 *  it, which is what retrieve_memory is for. */
export async function sessionStart(service, {sessionKey, event = 'SessionStart', repository = null,
  project, ownerId, traced = untraced} = {}) {
  return traced(`satchel.${event}`,
    {sessionId: sessionKey, userId: ownerId, metadata: {event, repository}, tags: ['satchel', event], input: null},
    async setOutput => {
      let context;
      let notice = '';
      let active = null;
      let logged = null;
      try {
        const status = await service.status();
        if (!status) throw {code: '42501'};
        const settings = await service.settings();
        const scope = project !== undefined ? {project, candidates: []}
          : await resolveScope(service, {sessionKey, repository});
        active = scope.project;
        const [projects, personal] = await Promise.all([
          // all_projects is its own scope: a blanket grant keeps no list, so
          // checking project_ids alone would load nothing for the connection
          // that was given everything.
          status.all_projects || status.project_ids?.length || status.personal ? service.projects() : [],
          status.personal ? service.personal() : [],
        ]);
        const block = sessionStartBlock({projects, personal});
        const tokens = estimateTokens(block);
        notice = noticeFor('SessionStart', {projects: projects.length, personal: personal.length});
        if (!block) {
          context = 'Satchel is connected and has nothing saved yet. Do not invent memory.';
        } else if (tokens > settings.session_budget_tokens) {
          // Withheld rather than truncated: a partial block that looks complete
          // is worse than an honest absence, because the agent cannot tell.
          context = `Satchel memory NOT loaded: ${tokens} tokens exceeds the ${settings.session_budget_tokens} budget for this session. Use retrieve_memory for anything you need; do not claim memory loaded.`;
          notice = noticeFor(event, {withheld: `${tokens} tokens over the ${settings.session_budget_tokens} budget`});
        } else {
          context = block;
          logged = {query: null, memory_ids: personal.map(m => m.id), matched: personal.length,
            in_scope: personal.length, tokens};
        }
        if (active) context += `\nactive project: ${active}`;
        else context += chooseProjectLine(scope.candidates);
      } catch (error) {
        context = 'Satchel memory unavailable. ' + errorText(error) + ' Do not claim that memory loaded.';
        notice = noticeFor(event, {error: errorText(error)});
      }
      if (logged) void service.logInjection({id: crypto.randomUUID(), session_key: sessionKey, event, ...logged});
      // The exact bytes the agent receives, so a trace answers "what did it
      // actually see" rather than "what did we intend to send".
      setOutput(context);
      return {active_project: active, context, notice};
    });
}

/** The end of a turn.
 *
 *  `messages` is what the hook script read out of the host's transcript since
 *  the last time it ran: the person's own typed messages and the assistant's
 *  plain text, and nothing else. They are recorded first, then the turn is
 *  whatever is still unclassified, which is a boundary rather than a guess.
 *
 *  It used to be the last capture_window user messages, so with the default of
 *  5 every Stop re-offered the last five and consecutive Stops overlapped by
 *  four. Anything durable got five chances and was duly saved twice. */
export async function capture(service, {sessionKey, repository = null, messages = [],
  project, ownerId, traced = untraced} = {}) {
  return traced('satchel.Stop',
    {sessionId: sessionKey, userId: ownerId, metadata: {event: 'Stop', repository}, tags: ['satchel', 'Stop'], input: null},
    async (setOutput, setInput) => {
      try {
        const status = await service.status();
        if (!status) throw {code: '42501'};
        const settings = await service.settings();
        if (!settings.capture || !service.captureTurn) return {captured: 0, notice: ''};
        // Recorded in order, so the window the router reads is the conversation
        // in the order it happened.
        for (const message of messages)
          await service.recordSessionMessage(sessionKey, message.role, message.content, settings.capture_window * 2);
        const window = await service.sessionWindow(sessionKey, settings.capture_window * 2);
        const ordered = [...window].reverse();
        const start = ordered.findIndex(m => m.classified_at == null && m.role === 'user');
        if (start === -1) return {captured: 0, notice: ''};
        const turn = ordered.slice(start).filter(m => m.role === 'user').map(m => m.content);
        if (!turn.length) return {captured: 0, notice: ''};
        // The turn being classified is the only thing that may supply a source.
        // Everything before it is there to understand it.
        const earlier = ordered.slice(0, start);
        setInput({turn, contextMessages: earlier.length});
        const scope = project !== undefined ? {project} : await resolveScope(service, {sessionKey, repository});
        const [projects, tasks, saved] = await Promise.all([
          service.projects(), service.openTasks(),
          service.capturedThisSession?.(sessionKey) ?? []]);
        const active = projects.find(p => p.id === scope.project) ?? null;
        // Named only when it is unambiguous. A project may link to several
        // repositories, and naming an arbitrary one of them would be worse
        // than naming none.
        const links = active?.project_repositories ?? [];
        const result = await service.captureTurn(sessionKey, {
          codebase: links.length === 1 ? links[0].repository : null,
          project: active ? {slug: active.slug, brief: active.brief} : null,
          projects: projects.filter(p => p.id !== scope.project).map(p => ({slug: p.slug, brief: p.brief})),
          tasks: tasks.map(t => ({slug: t.slug, title: t.title, project: projects.find(p => p.id === t.project_id)?.slug ?? null})),
          context: earlier, turn, saved});
        // The boundary moves only when the model actually answered. A run that
        // died on a rate limit leaves its messages for the next turn.
        const through = ordered[ordered.length - 1]?.id;
        if (result && !result.failed && through != null)
          void service.markSessionClassified?.(sessionKey, through);
        const captured = result?.memories?.length ?? 0;
        setOutput(result?.memories?.map(m => m.statement) ?? []);
        return {captured, notice: noticeFor('Stop', {captured})};
      } catch (error) {
        // Capture never injects, so a failure here reaches the person and no
        // one else. Silence would make a revoked grant look like a quiet turn.
        return {captured: 0, notice: noticeFor('Stop', {error: errorText(error)})};
      }
    });
}
