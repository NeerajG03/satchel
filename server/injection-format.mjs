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

/** Per prompt. The counts are the point: they let the agent tell "there is no
 *  rule about this" from "nothing scored high enough", which is the failure a
 *  silently truncated top-5 causes. */
export function promptBlock({rows = [], matched = 0, inScope = 0, churn = 25} = {}) {
  if (!rows.length) return '';
  const lines = [`◪ retrieved · ${rows.length} shown · ${matched} matched · ${inScope} in scope`];
  // A `[task closed, may be fixed]` hint used to hang off rows whose task had
  // been completed. It was the only thing the memory-to-task link ever
  // produced, and the link cost a scope the model could get wrong.
  //
  // The doubt was worth keeping and this is where it came back, raised by the
  // repository moving rather than by a task closing. Both stale rows in
  // production were made false by a migration and a commit, and nothing
  // anyone said contradicted either of them. The marker says how far the
  // repository has moved and stops there: a merge is a reason to check a
  // claim, never a reason to know it is wrong.
  for (const row of rows) {
    lines.push(`  ${handleOf(row.id)}  ${clip(row.statement, 300)}`);
    if (row.commits_since >= churn)
      lines.push(`          [${row.anchor_repository ?? 'the repo'} has moved ${row.commits_since} commits since this was confirmed, check before relying on it]`);
  }
  return lines.join('\n');
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

/** Session start. Only what applies no matter what you do today: the projects
 *  that exist, and every personal memory, up to the cap. Nothing scoped to a project or a task
 *  is injected here, because loading it assumes you will touch it.
 *
 *  `linked` is the projects this workspace's repository belongs to. When it is
 *  known, the others are counted rather than listed. A flat list of every
 *  project reads as though they all bear on the work in front of you: sitting
 *  in cbx1/backend and being shown `satchel` alongside the two projects that
 *  are actually linked there is three equal-looking options, two of which are
 *  right. The count keeps them discoverable without implying relevance, and
 *  list_projects still names them on request.
 *
 *  With nothing linked, which is every non-Git and unlinked workspace, there is
 *  nothing to filter by and the full list is the honest answer. */
export function sessionStartBlock({projects = [], personal = [], linked = [], cap = 30} = {}) {
  const lines = [];
  const ids = new Set(linked);
  const here = ids.size ? projects.filter(p => ids.has(p.id)) : projects;
  const elsewhere = ids.size ? projects.length - here.length : 0;
  if (here.length) {
    lines.push(ids.size ? 'projects in this codebase' : 'projects');
    const width = Math.max(...here.map(p => (p.slug ?? p.name ?? '').length));
    for (const project of here)
      lines.push(`  ${pad(project.slug ?? project.name ?? '', width)}  ${clip(project.brief, 70)}`.trimEnd());
  }
  // Inside the group, because that is where the reader is looking when the
  // question "is this all of them" occurs to them.
  if (elsewhere) lines.push(`  ${plural(elsewhere, 'other project')} not linked to this codebase, by name from list_projects`);
  const {said, heard, past} = personalLoad(personal, cap);
  if (said.length) {
    if (lines.length) lines.push('');
    lines.push('personal, confirmed, use freely');
    for (const memory of said) lines.push(`  ${handleOf(memory.id)}  ${clip(memory.statement, 300)}`);
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
    for (const memory of heard) lines.push(`  ${handleOf(memory.id)}  ${clip(memory.statement, 300)}`);
  }
  if (past) lines.push(`  ${plural(past, 'older memory', 'older memories')} past the block, search satchel for them`);
  if (!lines.length) return '';
  lines.push('');
  lines.push('more exists, search satchel for anything not listed above');
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
export function noticeFor(event, {error, withheld, unrecorded, projects = 0, personal = 0,
  shown = 0, matched = 0, captured = 0} = {}) {
  if (error) return `Satchel memory unavailable · ${error}`;
  if (withheld) return `Satchel memory not loaded · ${withheld}`;
  // Not the same as memory being unavailable: the prompt was still answered
  // and anything relevant still loaded. What was lost is the record of what
  // was said, which nothing later can reconstruct.
  if (unrecorded) return `Satchel did not record this turn · ${unrecorded}`;
  if (event === 'SessionStart')
    return projects || personal
      ? `Satchel loaded · ${plural(projects, 'project')}, ${plural(personal, 'personal memory', 'personal memories')}`
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
