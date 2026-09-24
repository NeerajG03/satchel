// What a Postgres or PostgREST failure means, in words the reader can act on.
//
// This is shared by the MCP tools and by the lifecycle hooks, which is the
// whole reason it is its own file: the same failure reaching an agent through a
// tool result and reaching a person through a session-start line has to say the
// same thing, and two copies of this table would not stay the same for long.
//
// It imports nothing, so a cheap endpoint can use it without pulling anything
// in behind it.
//
// The rule is that a refusal names what to change. A generic line used to stand
// in for every check violation, and on 23 September it left an agent retrying a
// valid slug twice against a rule that was failing on a slug Satchel had
// derived from the title itself. So every sentence a routine raises and every
// constraint a tool can reach is listed here, and
// tests/error-text-coverage.test.mjs fails when a migration adds one that is not.
//
// Only `message` is ever read from a database error. It is either a sentence
// one of our routines raised or Postgres naming a constraint. `details` is never
// shown: for a check violation it carries the whole failing row.

const WRITTEN_NOTHING=' Nothing was written.';
const SATCHEL_BUG='This is a fault in Satchel, not in your input, so retrying will not help. Report it to the user.';
const RESOURCES='resource_ids must name resources already attached to this task and verified, each listed once';

// Sentences raised by our own routines, by their exact text. The text a routine
// raises is written for a log; this is the version written for the agent.
export const raisedText={
  // 42501: the grant, not the input. The first six are thrown by the services
  // before any query, the rest by routines.
  'Connection unavailable':'This connection is no longer authorized. Ask the user to reconnect Satchel',
  'Memory read unavailable':'This connection may not read memories in that scope. Use a scope from list_projects',
  'Memory write unavailable':'This connection may not write memories in that scope. Use a scope list_projects shows as writable, or ask the user to grant write for it in Satchel',
  'Personal memory unavailable':'This connection has no grant for personal memory. Pass a project_id from list_projects, or ask the user to allow personal memory for it in Satchel',
  'Personal tasks unavailable':'This connection has no grant for personal tasks (project_id null). Pass a project_id from list_projects, or ask the user to allow personal tasks for it in Satchel',
  'Project tasks unavailable':'This connection has no task grant for that project. Use a project_id from list_projects, or ask the user to grant tasks for it in Satchel',
  'Task upload unavailable':'This connection may not attach resources to tasks. Ask the user to allow task uploads for it in Satchel',
  'Authentication required':'The connection is not signed in. Ask the user to reconnect Satchel',
  'Task write unavailable':'This connection may not write tasks in that scope. Ask the user to grant task write for it in Satchel, or use a scope from list_projects',
  'Project write unavailable':'This connection may not change that project. Ask the user to grant it in Satchel',
  'Scope unavailable':'This connection is not granted that scope. Use personal (project_id null) only if list_projects shows it, or a project_id from list_projects',
  // P0002: nothing matched in a scope this connection can see.
  'Task unavailable':'That task is not in the given project_id scope, or this connection cannot write it. Check the id and project_id with list_tasks',
  'Memory not found or unavailable':'That memory is not in the given project_id scope. Check the id and project_id with memory_index',
  'Record not found':'Satchel could not find the record it had just written. '+SATCHEL_BUG,
  'Repository is not linked to an authorized project':'That repository is not linked to a project in this connection\'s grant. Report that project memory was not loaded; do not guess a project',
  // PT409: two different causes that used to share one line.
  'Task request conflict':'Satchel could not save this task change. Check the task list before trying again',
  'Project request conflict':'Satchel could not save this project change. Check list_projects before trying again',
  'Memory request conflict':'Satchel could not save this memory. Check memory_index before trying again',
  'Task changed or unavailable':'The task changed since you read it, or it is not in this scope. Call read_task and retry with the current revision',
  'Project changed or unavailable':'The project changed since you read it, or it is not in this scope. Call list_projects and retry with the current revision',
  'Memory changed or unavailable':'The memory changed since you read it, or it is not in this scope. Read it again and retry with the current revision',
  // 23514 and 23505 raised by routines.
  'Invalid project change':'repository_change is invalid. link and unlink need a lowercase owner/repository, and unlink needs expected_revision because a new project has nothing to unlink',
  'A slug is lowercase words joined by hyphens, up to 40 characters':'A slug is lowercase letters and digits in words joined by single hyphens, up to 40 characters, like fix-consent-layout',
  'That slug is already in use':'That slug is already used by another of this user\'s tasks or projects. Pick another and retry',
  'Unknown slug kind':'Satchel asked for a slug on an unknown kind of record. '+SATCHEL_BUG,
  'A task cannot parent itself':'A task cannot be its own parent',
  'Parent task unavailable in this scope':'The parent task is not in this task\'s scope. Parent and child must share the same project_id, so check it with list_tasks',
  'Task parent cycle':'That parent would make a loop, because it already sits under this task. Pick a parent outside this task\'s subtree',
  'Dependency task unavailable in this scope':'The dependency task is not in this task\'s scope. Both tasks must share the same project_id, so check it with list_tasks',
  'Task dependency cycle':'That dependency would make a loop, because the other task already depends on this one',
  'Invalid comment resource':RESOURCES,
  'Invalid progress update':RESOURCES,
  'Invalid handoff resource':RESOURCES,
  'Invalid handoff supersession':'supersedes_ids must name earlier handoffs on this task, each listed once, and never this handoff',
  'Invalid task state':'status is one of inbox, ready, in_progress, blocked or done',
  'Blocked tasks require a reason':'A blocked status needs a blocked_reason saying what it is waiting on',
};
// A routine that interpolates a value raises a different string each time, so
// these are matched by pattern.
export const raisedPatterns=[
  [/^Repository is linked to \d+ projects in this grant/,'That repository belongs to more than one project, so it does not name one. Call list_projects and select_project with an explicit project_id'],
];

// Constraints a tool can reach where the value came from the agent, so the
// agent can fix it. The zod schemas check all of these first; this is what the
// agent reads when a schema and the table ever disagree.
export const constraintText={
  memories_statement_check:'statement is 1 to 500 characters',
  memories_source_check:'source is at most 4000 characters',
  memories_name_check:'name is 1 to 100 characters, or null',
  memories_more_info_check:'more_info is at most 40000 characters',
  memories_scope_name:'A memory with that name already exists in this scope. Pick another name, or correct the existing memory',
  memories_personal_name:'A personal memory with that name already exists. Pick another name, or correct the existing memory',
  projects_name_check:'A project name is 1 to 100 characters',
  projects_brief_check:'A project brief is at most 1000 characters',
  projects_slug_check:'A project slug is lowercase letters and digits in words joined by single hyphens, up to 40 characters',
  projects_owner_slug:'That slug is already used by another of this user\'s tasks or projects. Pick another and retry',
  project_repositories_repository_check:'A repository is a lowercase owner/repository, like acme/web',
  agent_session_scopes_session_key_check:'session_key is 1 to 200 characters',
  tasks_title_check:'A task title is 1 to 200 characters',
  tasks_outcome_check:'outcome is at most 1000 characters',
  tasks_why_check:'why is at most 4000 characters',
  tasks_next_action_check:'next_action is at most 1000 characters',
  tasks_done_when_check:'done_when has at most 20 items and none of them empty',
  tasks_done_when_check1:'done_when is at most 10000 characters in total',
  tasks_priority_check:'priority is one of low, medium, high or urgent',
  tasks_status_check:'status is one of inbox, ready, in_progress, blocked or done',
  tasks_check:'A blocked status needs a blocked_reason of at most 2000 characters, and any other status has none',
  tasks_slug_check:'A task slug is lowercase letters and digits in words joined by single hyphens, up to 40 characters',
  tasks_owner_slug:'That slug is already used by another of this user\'s tasks or projects. Pick another and retry',
  task_dependencies_check:'A task cannot depend on itself',
  task_parent_edges_check:'A task cannot be its own parent',
  task_updates_body_check:'A comment body is 1 to 4000 characters',
  task_updates_next_action_check:'next_action is at most 1000 characters',
  task_updates_status_check:'status is one of inbox, ready, in_progress, blocked or done',
  task_updates_check:'A blocked status needs a blocked_reason of at most 2000 characters, and any other status has none',
  task_updates_completed_check:'completed has at most 50 items',
  task_updates_decisions_check:'decisions has at most 50 items',
  task_updates_remaining_check:'remaining has at most 50 items',
  task_updates_blockers_check:'blockers has at most 50 items',
  task_updates_completed_check1:'completed is at most 20000 characters in total',
  task_updates_decisions_check1:'decisions is at most 20000 characters in total',
  task_updates_remaining_check1:'remaining is at most 20000 characters in total',
  task_updates_blockers_check1:'blockers is at most 20000 characters in total',
  task_handoffs_next_action_check:'A handoff next_action is 1 to 1000 characters',
  task_handoffs_summary_check:'A handoff summary is at most 4000 characters',
  task_handoffs_completed_check:'completed has at most 50 items',
  task_handoffs_decisions_check:'decisions has at most 50 items',
  task_handoffs_remaining_check:'remaining has at most 50 items',
  task_handoffs_blockers_check:'blockers has at most 50 items',
  task_handoffs_supersedes_ids_check:'supersedes_ids has at most 20 ids',
  task_handoffs_validation_check:'validation is a list of objects',
  task_resources_label_check:'A resource label is 1 to 200 characters',
  task_resources_resource_type_check:'resource_type is one of reference, document, image, artifact, repository or pull_request',
  task_resources_check:'url is an https URL with no spaces',
};

// Constraints only Satchel's own code can break: values it derives, stamps or
// counts itself. Hitting one means Satchel built a bad value, which is exactly
// what the slug from a title was, so the agent is told not to keep retrying.
export const internalConstraints=new Set([
  'memories_band_check','memories_embedding_pairing','memories_ended_by_only_when_replaced',
  'memories_ended_note_check','memories_ended_reason_check','memories_ended_together','memories_kind_check',
  'memories_mentions_check','project_repositories_provider_check','project_write_requests_payload_hash_check',
  'project_write_requests_result_check','projects_revision_check','task_events_check','task_events_details_check',
  'task_events_event_type_check','task_resources_failure_reason_check','task_resources_kind_check',
  'task_resources_upload_status_check','task_resources_object_key','task_updates_check1','task_updates_kind_check',
  'task_write_requests_operation_check','task_write_requests_payload_hash_check','tasks_check1','tasks_revision_check',
]);

// PostgREST's own codes. None of these is the agent's input.
const postgrestText={
  PGRST202:'This Satchel server called a database routine that is not installed, so the server and database are out of step. '+SATCHEL_BUG,
  PGRST116:'Satchel expected exactly one record back and got none or several. '+SATCHEL_BUG,
  PGRST301:'The connection token was refused. Ask the user to reconnect Satchel',
  PGRST303:'The connection token has expired. Ask the user to reconnect Satchel',
};

const codeText={
  '42501':'Access denied. Check the connection and granted memory or task scopes in Satchel.',
  'P0002':'The requested Satchel record is unavailable. Refresh before trying again.',
  'PT400':'Provide exactly one of project_id (null for personal scope) or repository.',
  'PT404':'That repository is not linked to a project in this connection\'s grant. Report that project memory was not loaded; do not guess a project.',
  'PT409':'Revision or request conflict. Read the current record; do not overwrite blindly.',
  'PT300':'That repository belongs to more than one project, so it does not name one. Call list_projects and select_project with an explicit project_id.',
  '23505':'This name is already used in the selected scope. Nothing was written.',
  '23514':'The supplied fields or relationships break a Satchel rule. Nothing was written.',
};
export const GENERIC='Satchel request failed. Reload before retrying a write: it may have completed.';

const sentence=text=>(text.charAt(0).toUpperCase()+text.slice(1)).replace(/\.?$/,'.');
const constraintName=message=>/constraint "([^"]+)"/.exec(message ?? '')?.[1];

function fromConstraint(error,name) {
  if(constraintText[name])return sentence(constraintText[name])+WRITTEN_NOTHING;
  if(internalConstraints.has(name))return `Satchel built a value that breaks its own rule ${name}. `+SATCHEL_BUG+WRITTEN_NOTHING;
  // Primary keys and the composite (owner, scope, id) keys that foreign keys
  // point at. Only a reused id can hit them.
  if(error.code==='23505'&&/(_pkey|_id_key)$/.test(name))return 'That id is already used by another record. Use a new id, or resend the identical payload to retry.'+WRITTEN_NOTHING;
  if(error.code==='23503')return `A record this refers to does not exist in the selected scope, so the rule ${name} refused it.`+WRITTEN_NOTHING;
  // A constraint added without a line above. The coverage test is meant to
  // stop that reaching production; this still names the field if it can.
  const table=/(?:relation|table) "([^"]+)"/.exec(error.message)?.[1];
  const field=table&&name.startsWith(table+'_')
    ?name.slice(table.length+1).replace(/_?(check|fkey|key)\d*$/,''):'';
  return (field?`The ${field} value breaks the rule ${name}.`:`The request breaks the rule ${name}.`)+WRITTEN_NOTHING;
}

function fromRaise(message) {
  if(raisedText[message])return raisedText[message];
  return raisedPatterns.find(([pattern])=>pattern.test(message))?.[1];
}

// Everything in classes 22 and 23 is refused before anything is stored, and so
// are the routine refusals below. A timeout or an unknown failure is not, which
// is why the generic line still warns that a write may have landed.
const refusedBeforeWriting=code=>/^2[23]/.test(code)||['42501','P0002','PT409','PT400','PT404','PT300'].includes(code);

export const errorText=error=>{
  if(error?.reason)return sentence(error.reason);
  const code=typeof error?.code==='string'?error.code:'';
  const message=typeof error?.message==='string'?error.message:'';
  if(postgrestText[code])return sentence(postgrestText[code]);
  const name=constraintName(message);
  if(name)return fromConstraint({code,message},name);
  const raised=message&&fromRaise(message);
  if(raised)return sentence(raised)+(refusedBeforeWriting(code)?WRITTEN_NOTHING:'');
  // A value Postgres could not read, like a malformed uuid, or a routine
  // sentence nobody has listed yet. Either quotes only the agent's own input or
  // our own words, so it is safe, and it beats a line that names nothing.
  if(/^2[23]/.test(code)&&message)return sentence(message)+WRITTEN_NOTHING;
  return codeText[code] ?? GENERIC;
};
