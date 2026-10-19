// The exact bytes that reach the model. Kept pure and in one place so the
// context preview in the companion can render what was actually injected
// rather than a description of it, which would mean auditing the description.
//
// Two rules, both from measurement rather than taste:
//
//   The headers carry the instructions. An earlier draft had a separate rules
//   preamble; a fixed instruction paragraph was 58% of a competitor's
//   per-prompt cost. A header only exists when its group does, sits beside the
//   rows it governs, and cannot be skipped the way a preamble can.
//
//   Handles, not UUIDs. Six characters is enough to name a row for a correction
//   and short enough that a model copies it without transposing.

export const handleOf = id => String(id).replace(/-/g, '').slice(0, 6);

const clip = (text, limit) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
};
const pad = (text, width) => text + ' '.repeat(Math.max(0, width - text.length));

/** Rough token estimate for budgeting. Deliberately an estimate, and reported
 *  as one, rather than a tokenizer dependency for a number used to decide
 *  whether a block fits. */
export const estimateTokens = text => Math.ceil(text.length / 3.8);

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** What sits in the parentheses between a row's handle and its statement.
 *
 *  Where a row came from, whether anyone confirmed it, and how often it has
 *  been said, in that order. Measured over a week of real prompts, rows from
 *  the wrong topic were injected into sessions about another one, and nothing
 *  in the line said so; and a picked-up row read exactly like a confirmed one,
 *  so the agent could not apply the rule the session-start header gives it.
 *  The count came later, from the 16 October retro: a rule the person had said
 *  twelve times and a fact heard once the night before were printed the same
 *  way, and the agent had no way to weigh one against the other.
 *
 *  `where` is the topic's slug or `personal`, for a row standing on its own in
 *  the prompt block. In the start block rows sit under a header that already
 *  says both the scope and the band, so the start block passes no `where` and
 *  only the count prints. An empty label prints nothing at all, so a start
 *  block row said once looks exactly as it did before the count existed. */
export function rowLabel(row, {where = null} = {}) {
  const parts = [];
  if (where) {
    parts.push(where);
    if (row.band === 'heard') parts.push('picked up');
  }
  if ((row.mentions ?? 1) >= 2) parts.push(`said ${row.mentions} times`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DRAFT_DAYS = 7;

/** The line under a young, unconfirmed topic row.
 *
 *  A draft is a topic row that was picked up, said once, and made under seven
 *  days ago. On the 16 October retro six such rows were shown 45 times while
 *  the decision they recorded was still being changed, and nothing in the
 *  block said they were a day old. The row stays: hiding it would take the
 *  current decision out of a sprint. The line tells the agent what it is and
 *  what to do, in the spot where it already reads the commits marker.
 *
 *  A row with no readable created_at gets no line, and a date in the future
 *  (clock skew between two servers) reads as today rather than as nonsense. */
export function draftMarker(row, now = new Date()) {
  if (!row.topic_id || row.band !== 'heard' || (row.mentions ?? 1) !== 1 || row.created_at == null) return '';
  // PostgREST writes `2026-10-15T08:00:00.1+00:00`; a raw dump writes
  // `2026-10-15 08:00:00+00`, which Date.parse refuses. Both read.
  const made = Date.parse(String(row.created_at).replace(' ', 'T').replace(/(:\d\d(?:\.\d+)?)([+-]\d\d)$/, '$1$2:00'));
  const at = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(made) || !Number.isFinite(at)) return '';
  const days = Math.max(0, Math.floor((at - made) / DAY_MS));
  if (days >= DRAFT_DAYS) return '';
  const age = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `          [picked up ${age}, said once, not confirmed since, check before relying on it]`;
}

/** The line under a row whose repository has moved since it was confirmed.
 *
 *  A preference never gets one: commits do not make a rule wrong. Facts and
 *  intents do, and an intent most of all, since commits are what complete a
 *  plan. Before 19 October this line sat under every row past the threshold,
 *  whatever its kind and whichever repository the session was in. A row about
 *  the repository this session is in keeps the full line, because the agent
 *  can check it right here. A row about another repository gets a short one:
 *  the doubt is the same, but a commit count for a repo the agent is not in
 *  is room spent on a number it cannot use. An unknown session repository
 *  counts as another one.
 *
 *  Both sides are the hook's normalized lowercase `owner/name`, which is also
 *  what the database stores in `anchor_repository`. */
export function commitsMarker(row, {churn = 25, repository = null} = {}) {
  if (!(row.commits_since >= churn) || row.kind === 'preference') return '';
  const here = Boolean(repository && row.anchor_repository)
    && String(repository).toLowerCase() === String(row.anchor_repository).toLowerCase();
  return here
    ? `          [${row.anchor_repository} has moved ${row.commits_since} commits since this was confirmed, check before relying on it]`
    : '          [may be out of date]';
}

/** Per prompt. The counts are the point: they let the agent tell "there is no
 *  rule about this" from "nothing scored high enough", which is the failure a
 *  silently truncated top-5 causes. `repository` is the session's own, from the
 *  hook, and decides how much the commits line says. */
export function promptBlock({rows = [], matched = 0, inScope = 0, churn = 25, slugs = {}, now = new Date(), repository = null} = {}) {
  if (!rows.length) return '';
  const lines = [`▣ retrieved · ${rows.length} shown · ${matched} matched · ${inScope} in scope`];
  const whereOf = row => (row.topic_id ? slugs[row.topic_id] ?? 'topic' : 'personal');
  // A `[task closed, may be fixed]` hint used to hang off rows whose task had
  // been completed. It was the only thing the memory-to-task link ever
  // produced, and the link cost a scope the model could get wrong.
  //
  // The doubt was worth keeping and this is where it came back, raised by the
  // repository moving rather than by a task closing. Both stale rows in
  // production were made false by a migration and a commit, and nothing
  // anyone said contradicted either of them. The marker says how far the
  // repository has moved and stops there: a merge is a reason to check a
  // claim, never a reason to know it is wrong. The draft line is the same
  // kind of doubt, raised by the row being young rather than the repo moving.
  for (const row of rows) {
    lines.push(`  ${handleOf(row.id)}  ${rowLabel(row, {where: whereOf(row)})}  ${clip(row.statement, 300)}`);
    const draft = draftMarker(row, now);
    if (draft) lines.push(draft);
    const moved = commitsMarker(row, {churn, repository});
    if (moved) lines.push(moved);
  }
  return lines.join('\n');
}

/** When a search is worth making, said inside the blocks rather than only in
 *  the shipped skill, which the agent may never load.
 *
 *  The blocks used to say only that more exists, and the skill said "you do
 *  not have to go and get context", so an agent read the two together as
 *  "do not search". The cue is what the person says, not what the work is
 *  about: a sentence that points back at an earlier choice is the one case
 *  retrieval on the prompt's own words most often misses.
 *
 *  `readsApproved` is true only when the plugin's PreToolUse hook is
 *  installed, which is Claude today. On Codex a read may still ask, and
 *  saying otherwise would be a claim the agent finds false on its first call. */
const WHEN_TO_SEARCH = 'when the user points back to an earlier decision or session, or says remember, we decided or last time';
const approval = readsApproved => (readsApproved ? '. it needs no approval' : '');

/** Said once a session, on the first prompt that matched nothing.
 *
 *  Silence after a miss reads as "there is nothing to find", so the agent
 *  never reaches for the tool. Once, because a miss is the common case and a
 *  line on every one of them would be a cost on every prompt. */
export function missNote({readsApproved = false} = {}) {
  return `▣ nothing new in Satchel matched this message closely enough to show\n`
    + `  other words or another topic may still find something. retrieve_memory is worth a call ${WHEN_TO_SEARCH},`
    + ` and not for work that stands on its own${approval(readsApproved)}`;
}

/** Which personal memories the session block injects. One function, used by
 *  the block and by the log, so the two cannot disagree about what the model
 *  saw.
 *
 *  Bounded, because the whole set loads and a set that loads whole has to be
 *  small. The rows arrive ranked: most said, most recently meant, first. What
 *  you asked for comes before what was picked up, and what falls past the cap
 *  is still live and still searchable. A rule is not wrong for being old. */
export function personalLoad(personal = [], cap = 30) {
  const room = Math.max(1, cap);
  const confirmed = personal.filter(m => m.band !== 'heard');
  const picked = personal.filter(m => m.band === 'heard');
  const said = confirmed.slice(0, room);
  const heard = picked.slice(0, Math.max(0, room - said.length));
  return {said, heard, past: personal.length - said.length - heard.length};
}

/** Which of the active topic's memories the session block injects.
 *
 *  Topic memories used to arrive only by topic, through retrieval, and the
 *  measurement that put personal memories in the block applies to them just
 *  as much: a rule about how the work in this codebase is done ("tickets move
 *  straight to Done", "one QA run per commit is enough") is relevant by kind
 *  of activity, and "fix this test" never searches for it. On the real
 *  sessions reviewed in September the shapes the pass caught best were
 *  topic decisions, and they were the ones that never loaded.
 *
 *  So when the workspace resolves to exactly one topic, its preferences
 *  load, then its most-said facts and intents, under their own cap. Personal
 *  rows keep the main cap to themselves; this is a smaller second block, not a
 *  share of the first, so a busy topic cannot push a standing personal rule
 *  out. Confirmed rows fill it before picked-up ones, same as personal. */
export function topicLoad(memories = [], cap = 15) {
  const room = Math.max(0, cap);
  const rank = m => (m.kind === 'preference' ? 0 : 1);
  const ordered = [...memories].sort((a, b) => rank(a) - rank(b)
    || (b.mentions ?? 1) - (a.mentions ?? 1)
    || String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  const said = ordered.filter(m => m.band !== 'heard').slice(0, room);
  const heard = ordered.filter(m => m.band === 'heard').slice(0, Math.max(0, room - said.length));
  return {said, heard, past: memories.length - said.length - heard.length};
}

/** Session start. What applies no matter what you do today: the topics
 *  that exist, every personal memory up to the cap, and, when the workspace
 *  is one topic, that topic's own rules under a smaller cap of their own.
 *
 *  `linked` is the topics this workspace's repository belongs to. When it is
 *  known, the others are counted rather than listed. A flat list of every
 *  topic reads as though they all bear on the work in front of you: sitting
 *  in cbx1/backend and being shown `satchel` alongside the two topics that
 *  are actually linked there is three equal-looking options, two of which are
 *  right. The count keeps them discoverable without implying relevance, and
 *  list_topics still names them on request.
 *
 *  With nothing linked, which is every non-Git and unlinked workspace, there is
 *  nothing to filter by and the full list is the honest answer. */
export function sessionStartBlock({topics = [], personal = [], linked = [], cap = 30,
  topic = null, topicMemories = [], topicCap = 15, now = new Date(), readsApproved = false} = {}) {
  const lines = [];
  // The header says the scope and the band, so the row carries only its count.
  const rowLine = memory => '  ' + [handleOf(memory.id), rowLabel(memory), clip(memory.statement, 300)].filter(Boolean).join('  ');
  const ids = new Set(linked);
  const here = ids.size ? topics.filter(p => ids.has(p.id)) : topics;
  const elsewhere = ids.size ? topics.length - here.length : 0;
  if (here.length) {
    lines.push(ids.size ? 'topics in this codebase' : 'topics');
    const width = Math.max(...here.map(p => (p.slug ?? p.name ?? '').length));
    for (const topic of here)
      lines.push(`  ${pad(topic.slug ?? topic.name ?? '', width)}  ${clip(topic.brief, 70)}`.trimEnd());
  }
  // Inside the group, because that is where the reader is looking when the
  // question "is this all of them" occurs to them.
  if (elsewhere) lines.push(`  ${plural(elsewhere, 'other topic')} not linked to this codebase, by name from list_topics`);
  const {said, heard, past} = personalLoad(personal, cap);
  if (said.length) {
    if (lines.length) lines.push('');
    lines.push('personal, confirmed, use freely');
    for (const memory of said) lines.push(rowLine(memory));
  }
  // Picked up from what the person said, and not yet said again. Loaded,
  // because memory is hands off: nobody is asked to approve a row, and a
  // preference nobody loads is a preference nobody follows, since "fix this
  // bug" never searches for "keep comments rare". Its own group so a trace
  // shows which rows were picked up, and so the handle is there if one needs
  // correcting. A pass that hears it again confirms it and it moves up.
  //
  // This reverses the 21 September rule that counted these and loaded none.
  // That rule was right for the captures of the day, which were wrong; the
  // consolidation pass that writes them now reads whole conversations, and
  // on 23 September its picks held up against a blind read of the same ones.
  if (heard.length) {
    if (lines.length) lines.push('');
    lines.push('personal, picked up from what you said, use unless told otherwise');
    for (const memory of heard) lines.push(rowLine(memory));
  }
  if (past) lines.push(`  ${plural(past, 'older memory', 'older memories')} past the block, search satchel for them`);
  // The active topic's own block, after personal. Only when one topic was
  // resolved: with two candidates nothing is scoped, and loading either one's
  // rules would be the guess the choose-a-topic line exists to refuse.
  if (topic) {
    const own = topicLoad(topicMemories, topicCap);
    const slug = topic.slug ?? topic.name ?? 'topic';
    if (own.said.length) {
      if (lines.length) lines.push('');
      lines.push(`topic ${slug}, confirmed, applies to work in this codebase`);
      for (const memory of own.said) lines.push(rowLine(memory));
    }
    // The only group a draft can sit in: a draft is a topic row nobody has
    // confirmed, and said rows and personal rows are never drafts.
    if (own.heard.length) {
      if (lines.length) lines.push('');
      lines.push(`topic ${slug}, picked up from what you said, use unless told otherwise`);
      for (const memory of own.heard) {
        lines.push(rowLine(memory));
        const draft = draftMarker(memory, now);
        if (draft) lines.push(draft);
      }
    }
    if (own.past) lines.push(`  ${plural(own.past, 'more topic memory', 'more topic memories')} not loaded, search satchel for them`);
  }
  if (!lines.length) return '';
  lines.push('');
  lines.push(`more exists than is listed here. search it with retrieve_memory ${WHEN_TO_SEARCH}${approval(readsApproved)}`);
  // The mark is the only way to tell, from a transcript, that a row did work.
  // The injection review counts it.
  lines.push('when a Satchel row shaped your answer, mark that part with ▣');
  return `<satchel>\n${lines.join('\n')}\n</satchel>`;
}

/** The one line the person sees in their own terminal.
 *
 *  It exists because a broken Satchel and a quiet one looked identical from
 *  where they sit. A revoked grant made every hook inject "memory unavailable"
 *  to the model and say nothing to the person, which cost an hour of debugging
 *  that a single line would have ended.
 *
 *  So the rule is: a failure always speaks, and a success speaks only when
 *  something actually happened. Retrieval finding nothing is the common case
 *  and stays silent, because a line on every prompt is noise people learn to
 *  ignore, and Codex renders this as a warning. */
export function noticeFor(event, {error, withheld, unrecorded, topics = 0, personal = 0,
  topicMemories = 0, shown = 0, matched = 0, captured = 0} = {}) {
  if (error) return `Satchel memory unavailable · ${error}`;
  if (withheld) return `Satchel memory not loaded · ${withheld}`;
  // Not the same as memory being unavailable: the prompt was still answered
  // and anything relevant still loaded. What was lost is the record of what
  // was said, which nothing later can reconstruct.
  if (unrecorded) return `Satchel did not record this turn · ${unrecorded}`;
  if (event === 'SessionStart')
    return topics || personal || topicMemories
      ? `Satchel loaded · ${plural(topics, 'topic')}, ${plural(personal, 'personal memory', 'personal memories')}`
        + (topicMemories ? `, ${plural(topicMemories, 'topic memory', 'topic memories')}` : '')
      : 'Satchel connected · nothing saved yet';
  // Counts, not just a number shown, because "2 of 9" and "2 of 2" mean very
  // different things about whether anything was left behind.
  if (event === 'UserPromptSubmit') return shown ? `Satchel recalled ${shown} of ${matched} matching` : '';
  // A heard memory is the one thing the person must be told about: it was
  // written without them asking, and it stays unconfirmed until they say it
  // again.
  if (event === 'Stop') return captured ? `Satchel noted ${plural(captured, 'thing')} you said · unconfirmed` : '';
  return '';
}
