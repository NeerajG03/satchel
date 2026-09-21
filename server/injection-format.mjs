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

/** Session start. Only what applies no matter what you do today: the projects
 *  that exist, and every personal memory. Nothing scoped to a project or a task
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
export function sessionStartBlock({projects = [], personal = [], linked = []} = {}) {
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
  const said = personal.filter(m => m.band !== 'heard');
  const heard = personal.filter(m => m.band === 'heard');
  if (said.length) {
    if (lines.length) lines.push('');
    lines.push('personal, confirmed, use freely');
    for (const memory of said) lines.push(`  ${handleOf(memory.id)}  ${clip(memory.statement, 300)}`);
  }
  if (heard.length) {
    if (lines.length) lines.push('');
    lines.push('personal, not confirmed, say these out loud before relying on them');
    for (const memory of heard) lines.push(`  ${handleOf(memory.id)}  ${clip(memory.statement, 300)}`);
  }
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
 *  something actually happened. Most turns capture nothing, and those stay
 *  silent: a line at the end of every turn is noise people learn to ignore,
 *  and Codex renders this as a warning. */
export function noticeFor(event, {error, withheld, projects = 0, personal = 0, captured = 0} = {}) {
  if (error) return `Satchel memory unavailable · ${error}`;
  if (withheld) return `Satchel memory not loaded · ${withheld}`;
  if (event === 'SessionStart') {
    return projects || personal
      ? `Satchel loaded · ${plural(projects, 'project')}, ${plural(personal, 'personal memory', 'personal memories')}`
      : 'Satchel connected · nothing saved yet';
  }
  // A heard memory is the one thing the person must be told about: it was
  // written without them asking, and it stays unconfirmed until they say so.
  if (event === 'Stop') return captured ? `Satchel noted ${plural(captured, 'thing')} you said · unconfirmed` : '';
  return '';
}
