// What a session start injects, and what the end of a turn captures.
//
// This used to live inside createMemoryServer, reachable only as the
// load_memory_context MCP tool. That tool is gone: hooks are command scripts
// now, holding their own OAuth credential, so they call an HTTP endpoint
// instead of asking the host to make a tool call on their behalf. The logic
// did not change, so it moved here rather than being rewritten, and
// select_project still uses it for the manual recovery path.
//
// Three entry points and nothing else:
//
//   sessionStart   projects + every personal memory, once per session
//   retrieve       memories close to what the user just said, every prompt
//   capture        the turn that just ended, classified, maybe saved
//
// retrieve was briefly deleted on the belief that a command hook is not handed
// the prompt text. It is: the host builds the input as
// `{…, hook_event_name:"UserPromptSubmit", prompt, session_title}`, which the
// binary settles and no amount of reading the docs did. Nothing about this
// needs the transcript, which is why capture does not read one.
import {sessionStartBlock, promptBlock, estimateTokens, noticeFor} from './injection-format.mjs';
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
const untraced = (_name, _options, run) => run(() => {}, () => {}, null);

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
  // Still asked, even with a scope already chosen, because the session-start
  // block needs to know which projects belong to this codebase in order to
  // stop listing the ones that do not. Read-only in that case: the session key
  // survives a /clear, so an explicit select_project made earlier is still
  // active and must not be quietly overwritten.
  const rows = repository
    ? await service.resolveRepository(sessionKey, PROVIDER, repository, !active) ?? []
    : [];
  const linked = rows.map(row => row.project_id);
  if (active) return {project: active, linked, candidates: []};
  const selected = rows.find(row => row.selected);
  // `candidates` is the narrower thing: projects this repository names when it
  // names more than one, so nothing could be chosen. `linked` is every project
  // the repository belongs to, chosen or not.
  return {project: selected?.project_id ?? null, linked, candidates: selected ? [] : rows};
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
        const scope = project !== undefined ? {project, linked: [], candidates: []}
          : await resolveScope(service, {sessionKey, repository});
        active = scope.project;
        const [projects, personal] = await Promise.all([
          // all_projects is its own scope: a blanket grant keeps no list, so
          // checking project_ids alone would load nothing for the connection
          // that was given everything.
          status.all_projects || status.project_ids?.length || status.personal ? service.projects() : [],
          status.personal ? service.personal() : [],
        ]);
        const block = sessionStartBlock({projects, personal, linked: scope.linked ?? [],
          cap: settings.block_size});
        const tokens = estimateTokens(block);
        // What the block actually injects, which is no longer all of it: an
        // unconfirmed memory is counted and withheld. The log has to say what
        // reached the model, not what was fetched, or "why did it not know
        // that" stops being answerable from the log.
        const loaded = personal.filter(m => m.band !== 'heard').slice(0, settings.block_size);
        notice = noticeFor('SessionStart', {projects: projects.length, personal: loaded.length,
          unconfirmed: personal.length - loaded.length});
        if (!block) {
          context = 'Satchel is connected and has nothing saved yet. Do not invent memory.';
        } else if (tokens > settings.session_budget_tokens) {
          // Withheld rather than truncated: a partial block that looks complete
          // is worse than an honest absence, because the agent cannot tell.
          context = `Satchel memory NOT loaded: ${tokens} tokens exceeds the ${settings.session_budget_tokens} budget for this session. Use retrieve_memory for anything you need; do not claim memory loaded.`;
          notice = noticeFor(event, {withheld: `${tokens} tokens over the ${settings.session_budget_tokens} budget`});
        } else {
          context = block;
          logged = {query: null, memory_ids: loaded.map(m => m.id), matched: loaded.length,
            in_scope: loaded.length, tokens};
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

/** Every prompt.
 *
 *  Two jobs, and the first one runs whether or not the second does: the user's
 *  message is recorded, because the rolling window the router reads at the end
 *  of the turn is built from exactly this. That coupling is easy to miss and
 *  was missed once, which is how deleting retrieval silently took capture with
 *  it.
 *
 *  Then, if per_prompt_matches is set, the prompt is embedded and searched, and
 *  the closest memories above the gate come back with counts. The counts are
 *  the point: they separate "there is no rule about this" from "nothing scored
 *  high enough". */
export async function retrieve(service, {sessionKey, prompt, repository = null,
  exclude = [], project, ownerId, traced = untraced, retrieval} = {}) {
  return traced('satchel.UserPromptSubmit',
    {sessionId: sessionKey, userId: ownerId, metadata: {event: 'UserPromptSubmit'},
     tags: ['satchel', 'UserPromptSubmit'], input: prompt},
    async setOutput => {
      let context = '';
      let notice = '';
      let logged = null;
      let unrecorded = '';
      try {
        const status = await service.status();
        if (!status) throw {code: '42501'};
        const settings = await service.settings();
        // Awaited now, where it used to be fired and forgotten.
        //
        // A serverless function can freeze the moment it responds, so `void`
        // here meant the write could be killed mid flight. Against a 24 hour
        // rolling window that was a fair trade for the five second budget on a
        // hook that must not delay the prompt. Against a durable document it
        // is not, and it fails in the worst direction: the user's half is the
        // only half that may supply a memory's source, so losing it does not
        // degrade a document, it voids it.
        //
        // Its failure is held separately from retrieval's. Recording the turn
        // and answering the prompt are two jobs and neither should take the
        // other down.
        if (settings.capture)
          try { await service.recordTurn(sessionKey, 'user', prompt, settings.capture_window * 2); }
          catch (error) { unrecorded = errorText(error); }
        if (settings.per_prompt_matches) {
          const scope = project !== undefined ? {project} : await resolveScope(service, {sessionKey, repository});
          const lookup = retrieval?.('retrieve-memory', {input: prompt,
            metadata: {gate: settings.gate, limit: settings.per_prompt_matches,
              inScope: scope.project ?? 'personal', excluded: exclude.length}});
          let rows;
          try {
            rows = await service.search({query: prompt, in_scope: scope.project ?? null,
              limit: settings.per_prompt_matches, gate: settings.gate,
              boost: settings.scope_boost, exclude});
          } catch (error) { lookup?.fail(error); throw error; }
          lookup?.end(rows.map(r => ({id: r.id, statement: r.statement, score: r.score})),
            {metadata: {shown: rows.length, matched: rows[0]?.matched ?? 0, inScope: rows[0]?.in_scope ?? 0}});
          // Nothing relevant is a real answer, and the common one. It costs
          // nothing and says nothing.
          if (rows.length) {
            notice = noticeFor('UserPromptSubmit', {shown: rows.length, matched: rows[0].matched});
            context = promptBlock({rows, matched: rows[0].matched, inScope: rows[0].in_scope,
              churn: settings.staleness_commits});
            logged = {query: prompt, memory_ids: rows.map(r => r.id),
              matched: rows[0].matched, in_scope: rows[0].in_scope, tokens: estimateTokens(context)};
          }
        }
      } catch (error) {
        context = '';
        notice = noticeFor('UserPromptSubmit', {error: errorText(error)});
      }
      // Said last because it outranks the rest. "recalled 2 of 9" is
      // information; a turn that was not kept is something the person can act
      // on, and the next capture will be missing it.
      if (unrecorded) notice = noticeFor('UserPromptSubmit', {unrecorded});
      if (logged) void service.logInjection({id: crypto.randomUUID(), session_key: sessionKey,
        event: 'UserPromptSubmit', ...logged});
      setOutput(context);
      return {context, notice};
    });
}

/** The end of a turn.
 *
 *  `assistant` is the host's own last_assistant_message, which the Stop hook
 *  input carries. Nothing is read from disk: the user's side of the turn was
 *  already recorded by retrieve() when the prompt came in, so the window is
 *  complete without parsing anything.
 *
 *  The turn is whatever is still unclassified, which is a boundary rather than
 *  a guess.
 *
 *  It used to be the last capture_window user messages, so with the default of
 *  5 every Stop re-offered the last five and consecutive Stops overlapped by
 *  four. Anything durable got five chances and was duly saved twice. */
export async function capture(service, {sessionKey, repository = null, assistant = '',
  commits = null, project, ownerId, traced = untraced} = {}) {
  return traced('satchel.Stop',
    {sessionId: sessionKey, userId: ownerId, metadata: {event: 'Stop', repository}, tags: ['satchel', 'Stop'], input: null},
    async (setOutput, setInput, traceId) => {
      try {
        const status = await service.status();
        if (!status) throw {code: '42501'};
        const settings = await service.settings();
        // The setting is checked first. It is about whether the conversation is
        // kept at all, so a turn must not reach session_messages either; the
        // mcp_tool version recorded the reply before looking and that was
        // wrong, quietly, for every user who had capture switched off.
        if (!settings.capture) return {captured: 0, notice: ''};
        // Resolved before the write rather than after it, because the scope is
        // part of what gets recorded. A cron job reading this document hours
        // later has no workspace and no git remote to resolve it from, so if
        // the end of the turn does not say which project this was, nothing
        // ever will.
        const scope = project !== undefined ? {project} : await resolveScope(service, {sessionKey, repository});
        // How far the repository has come, recorded here and nowhere else.
        // Every hook could report it, but the per-prompt one has a five
        // second budget and this is the hook that is allowed to be heavy. Once
        // a turn is fresh enough for a doubt measured in tens of commits.
        if (repository && commits != null)
          await service.recordRepositoryHead?.(repository, commits);
        // The reply lands before the window is read, so the router sees the
        // turn it is classifying rather than the one before it.
        //
        // Called even when there is no reply. Codex hands us no
        // last_assistant_message, so on that host this writes no turn at all
        // and exists only to note the scope, which is the one thing the end of
        // a turn always knows.
        await service.recordTurn(sessionKey, 'assistant', assistant, settings.capture_window * 2, scope.project ?? null);
        // Without a router there is nothing to classify. The document is still
        // written above, because raw material is worth keeping whether or not
        // anything reads it today.
        //
        // `session` mode is the same answer for a different reason: the
        // conversation is read later, whole, against what is already
        // remembered, and classifying it a turn at a time as well would mean
        // two writers saving the same claim in two wordings. Which one runs is
        // a setting rather than a deploy, because what schedules the pass is
        // still an open decision and switching before something calls it would
        // mean no capture at all.
        if (!service.captureTurn || settings.capture_mode === 'session')
          return {captured: 0, notice: ''};
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
        const [projects, saved] = await Promise.all([
          service.projects(), service.capturedThisSession?.(sessionKey) ?? []]);
        const active = projects.find(p => p.id === scope.project) ?? null;
        // Named only when it is unambiguous. A project may link to several
        // repositories, and naming an arbitrary one of them would be worse
        // than naming none.
        const links = active?.project_repositories ?? [];
        const result = await service.captureTurn(sessionKey, {
          codebase: links.length === 1 ? links[0].repository : null,
          project: active ? {slug: active.slug, brief: active.brief} : null,
          projects: projects.filter(p => p.id !== scope.project).map(p => ({slug: p.slug, brief: p.brief})),
          context: earlier, turn, saved, trace: traceId});
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
