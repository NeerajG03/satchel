// What a Postgres or PostgREST code means, in words the reader can act on.
//
// This is shared by the MCP tools and by the lifecycle hooks, which is the
// whole reason it is its own file: the same failure reaching an agent through a
// tool result and reaching a person through a session-start line has to say the
// same thing, and two copies of this table would not stay the same for long.
//
// It imports nothing, so a cheap endpoint can use it without pulling anything
// in behind it.
// A failure that can say what it was says it. Everything from the embedder and
// the router carries a plain-words `reason`, because routing those through the
// code table below produced "Satchel request failed. Reload before retrying a
// write: it may have completed" for a spent embedding quota: unhelpful, and
// also untrue, since nothing was written.
export const errorText=error=>error?.reason
  ?(error.reason.charAt(0).toUpperCase()+error.reason.slice(1)).replace(/\.?$/,'.')
  :({
  '42501':'Access denied. Check the connection and granted memory or task scopes in Satchel.',
  'P0002':'The requested Satchel record is unavailable. Refresh before trying again.',
  'PT400':'Provide exactly one of project_id (null for personal scope) or repository.',
  'PT404':'That repository is not linked to a project in this connection\'s grant. Report that project memory was not loaded; do not guess a project.',
  'PT409':'Revision or request conflict. Read the current record; do not overwrite blindly.',
  'PT300':'That repository belongs to more than one project, so it does not name one. Call list_projects and select_project with an explicit project_id.',
  '23505':'This name is already used in the selected scope.',
  '23514':'The supplied fields or relationships violate the Satchel contract.',
}[error?.code] ?? 'Satchel request failed. Reload before retrying a write: it may have completed.');

