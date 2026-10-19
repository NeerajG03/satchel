// What a failed request means, in words the person can act on.
//
// This is the web app's copy of server/error-text.mjs. That file is written for
// an agent and talks about topic_id and list_topics. This one is written for
// the person at the keyboard, so it names the page, the button and what to do.
//
// It is plain JavaScript and imports nothing, so node --test can check it
// without a bundler, and tests/web-error-text.test.mjs fails when a routine the
// web app calls raises a sentence that has no line here.
//
// The rule that started this file: "Sign in again" is only said when the
// session really is gone. Postgres uses 42501 for every refusal, and most of
// ours have nothing to do with sign-in. On 19 October a topic delete was
// refused by the storage trigger that guards storage.objects, and the person,
// who was signed in, was told to sign in again.
//
// So every raise in our routines carries its reason in the hint, as
// satchel:<reason>, and that decides. The sentence is a log line that can be
// reworded, so it is only read when a database older than
// 20261019100000_refusals_say_why.sql sent no hint.
//
// Only `message` and `hint` are read from a database error, and neither is
// shown, except a satchel:person message, which a routine wrote for the
// person. Postgres puts the failing row in `details`, so every other sentence
// the person sees is written here.
/** An error whose message is already a sentence for the person, written by us. */
export class Sentence extends Error {}

const SESSION='Your sign-in has expired. Sign in again, then try once more. Nothing was changed.';
const RELOAD_TASK='Reload the task and try again.';
const FILES_NOT_READY='One of the files or links you picked is not ready, or is not on this task. '+RELOAD_TASK+' Nothing was saved.';
const SATCHEL_FAULT='This is a fault in Satchel, not something you did, so trying again will not help. Report it.';
const SHORT_NAME_TAKEN='That short name is already used by another of your topics or tasks. Pick a different one.';
const SHORT_NAME_SHAPE='A short name is lowercase words joined by hyphens, up to 40 characters, like web-launch.';
const BLOCKED_REASON='A blocked task needs a reason. Say what it is waiting on.';

// The reason a routine gave in its hint, with what the web app shows for it.
// A reason reached only by an agent token still gets a line, because the
// test cannot tell which branch a web call takes.
export const reasonText={
  // Signed in, but the thing is gone, moved, or not allowed.
  'refused:topic_write':'One of these topics can no longer be changed from here, so nothing was changed. Reload the topics page to see where things stand.',
  'refused:task_write':'Tasks can no longer be added to this topic. It may have been deleted or merged. Reload the page and pick a topic. Nothing was saved.',
  'refused:task_upload':'This file can no longer be attached. The task or its upload may be gone. '+RELOAD_TASK,
  'refused:memory_write':'Satchel would not move this memory into that scope, so nothing was moved. Reload the page to see where it is now.',
  'refused:repository_link':'This topic could not take the link. It may have been deleted or merged. Reload the page. Nothing was linked.',
  'refused:topic_selection':'One of the topics you picked is gone. Reload this page and choose again. Nothing was allowed.',
  'refused:scope':'That scope is not open to this app. Reload the page and choose again. Nothing was changed.',
  'refused:connection':'That app’s access was revoked. Connect it again from Apps. Nothing was changed.',
  'refused:memory_read':'That scope is not open to this app. Nothing was read.',
  'refused:personal_memory':'That app may not read your personal memory. Nothing was read.',
  'refused:personal_tasks':'That app may not reach your personal tasks. Nothing was changed.',
  'refused:topic_tasks':'That app may not reach tasks in this topic. Nothing was changed.',
  'refused:overnight_off':'Switch the overnight pass on first.',
  // Gone.
  'gone:topic':'This topic is already gone. It may have been deleted in another tab. Reload the topics list.',
  'gone:task':'This task is already gone. It may have been deleted in another tab. Reload the task list.',
  'gone:task_moved':'This task is gone or was moved to another scope, so nothing was saved. Reload the task.',
  'gone:memory':'This memory is gone or was archived. Reload the book.',
  'gone:record':'Satchel could not find what it had just saved. Reload the page to see whether it is there.',
  'gone:repository_topic':'That repository is not linked to a topic this app may see. Nothing was changed.',
  // Changed since the page loaded.
  'conflict:topic_revision':'This topic changed while you were looking, so nothing was deleted. Reload it and check before you delete.',
  'conflict:task_revision':'This task changed while you were looking, so nothing was deleted. Reload it and check before you delete.',
  'conflict:topic':'This topic changed or was merged since the page loaded, so nothing was changed. Reload to see the latest version.',
  'conflict:task':'This task changed since the page loaded, so nothing was saved. Reload to see the latest version, then try again.',
  'conflict:memory':'This memory changed or was archived since the page loaded, so nothing was saved. Reload to see the latest version.',
  'conflict:upload':'This upload already finished or was cancelled. Reload the task to see its files.',
  'conflict:task_request':'Satchel could not tell this change apart from an earlier one, so it saved nothing. Reload the task, then try again.',
  'conflict:topic_request':'Satchel could not tell this change apart from an earlier one, so it saved nothing. Reload the topic, then try again.',
  'conflict:memory_request':'Satchel could not tell this memory apart from an earlier save, so it saved nothing. Reload the book, then try again.',
  // Something you picked or typed.
  'invalid:slug_taken':SHORT_NAME_TAKEN,
  'invalid:slug_shape':SHORT_NAME_SHAPE,
  'invalid:topic_merged':'That topic was merged into another one, so nothing was moved. Move it into the topic it went into.',
  'invalid:topic_has_work':'That topic has tasks or linked repositories, so only you can merge it, from the topics page.',
  'invalid:no_scope':'Choose at least one scope to allow. Nothing was allowed.',
  'invalid:parent_self':'A task can’t be its own parent. Pick a different parent. Nothing was saved.',
  'invalid:parent_scope':'The parent you picked is gone or in a different scope. Pick a task from the same list. Nothing was saved.',
  'invalid:parent_cycle':'That task already sits under this one, so it can’t be its parent. Pick a different parent. Nothing was saved.',
  'invalid:dependency_scope':'The task you picked is gone or in a different scope. Pick a task from the same list. Nothing was saved.',
  'invalid:dependency_cycle':'That task already waits on this one, so this one can’t wait on it. Pick a different task. Nothing was saved.',
  'invalid:task_resource':FILES_NOT_READY,
  'invalid:task_state':'That state is not one Satchel knows. Reload the page and pick again. Nothing was saved.',
  'invalid:task_scope':'That task is not in this scope. Reload the page. Nothing was saved.',
  'invalid:blocked_reason':BLOCKED_REASON,
  'invalid:refresh_token':'Satchel did not get the overnight sign-in back, so nothing was switched on. Switch the overnight pass on again.',
  'invalid:overnight_https':'The overnight pass can only be switched on from the hosted Satchel, over https. Open it there.',
  'invalid:repository_hint':'That repository name is not one Satchel can read. Nothing was changed.',
  'invalid:repository_ambiguous':'That repository is linked to more than one topic, so it does not pick one. Nothing was changed.',
  // Only Satchel's own code can send these.
  'fault:slug_kind':'Satchel asked for a short name on something it does not know. '+SATCHEL_FAULT,
  'fault:topic_change':'Satchel sent a topic change it could not read, so nothing was saved. '+SATCHEL_FAULT,
  'fault:handoff':'Satchel sent a handoff it could not read, so nothing was saved. '+SATCHEL_FAULT,
};

// Reasons that are not a line in reasonText. satchel:session is a guard that
// found no auth.uid(), satchel:app_token one that found a client_id in the
// token, and satchel:person a sentence private.schedule_problem wrote for the
// person, raised as-is.
export const SESSION_REASON='session';
export const APP_TOKEN_REASON='app_token';
export const PERSON_REASON='person';

// The fallback for a database that sends no hint: the sentence each routine
// raised before 20261019100000_refusals_say_why.sql, with the reason it now
// gives. The four *_tasks and *_memory lines are thrown by the MCP server
// rather than raised, and have no hint at all.
const reasonBySentence={
  'Topic write unavailable':'refused:topic_write',
  'Task write unavailable':'refused:task_write',
  'Task upload unavailable':'refused:task_upload',
  'Memory write unavailable':'refused:memory_write',
  'Repository link unavailable':'refused:repository_link',
  'Invalid topic selection':'refused:topic_selection',
  'Scope unavailable':'refused:scope',
  'Connection unavailable':'refused:connection',
  'Memory read unavailable':'refused:memory_read',
  'Personal memory unavailable':'refused:personal_memory',
  'Personal tasks unavailable':'refused:personal_tasks',
  'Topic tasks unavailable':'refused:topic_tasks',
  'Switch the overnight pass on first.':'refused:overnight_off',
  'Topic not found':'gone:topic',
  'Task not found':'gone:task',
  'Task unavailable':'gone:task_moved',
  'Memory not found or unavailable':'gone:memory',
  'Record not found':'gone:record',
  'Repository is not linked to an authorized topic':'gone:repository_topic',
  'Topic revision conflict':'conflict:topic_revision',
  'Task revision conflict':'conflict:task_revision',
  'Topic changed or unavailable':'conflict:topic',
  'Task changed or unavailable':'conflict:task',
  'Memory changed or unavailable':'conflict:memory',
  'Upload is not pending':'conflict:upload',
  'Task request conflict':'conflict:task_request',
  'Topic request conflict':'conflict:topic_request',
  'Memory request conflict':'conflict:memory_request',
  'That slug is already in use':'invalid:slug_taken',
  'A slug is lowercase words joined by hyphens, up to 40 characters':'invalid:slug_shape',
  'A slug is lowercase words joined by hyphens, 3 to 40 characters':'invalid:slug_shape',
  'Topic was merged':'invalid:topic_merged',
  'Topic has tasks or repositories':'invalid:topic_has_work',
  'Select a memory or task scope':'invalid:no_scope',
  'A task cannot parent itself':'invalid:parent_self',
  'Parent task unavailable in this scope':'invalid:parent_scope',
  'Task parent cycle':'invalid:parent_cycle',
  'Dependency task unavailable in this scope':'invalid:dependency_scope',
  'Task dependency cycle':'invalid:dependency_cycle',
  'Invalid comment resource':'invalid:task_resource',
  'Invalid progress update':'invalid:task_resource',
  'Invalid handoff resource':'invalid:task_resource',
  'Invalid task state':'invalid:task_state',
  'Task is not in this memory scope':'invalid:task_scope',
  'Blocked tasks require a reason':'invalid:blocked_reason',
  'A refresh token is required':'invalid:refresh_token',
  'The overnight pass can only call this deployment over https.':'invalid:overnight_https',
  'Invalid repository hint':'invalid:repository_hint',
  'Unknown slug kind':'fault:slug_kind',
  'Invalid topic change':'fault:topic_change',
  'Invalid handoff supersession':'fault:handoff',
};
export const raisedText=Object.fromEntries(Object.entries(reasonBySentence).map(([sentence,reason])=>[sentence,reasonText[reason]]));

// The old sentences of guards that refused both a missing session and an app
// token with one raise. Without a hint they cannot say which, so they never
// decide "sign in again" on their own: the caller asks the auth client
// whether a session is still there, and passes the answer in as `signedIn`.
// See explain() in src/client.ts.
export const sessionGuards=new Set([
  'Authentication required',
  'Companion sign-in required',
  'Delete unavailable',
  'Your conversations are readable from your own session only',
  'Only you can change this, from the web app',
]);
// A request that reached the database as the anonymous role, which has no
// grant on anything the web app calls. Postgres raises this itself, with no
// hint, so the session check settles it too.
const ANON=/^permission denied for (function|table|schema|sequence|view)/;
// The session is there, and the guard still refused. That is not something
// signing in again fixes, so it does not say to.
const SESSION_REFUSED='Satchel did not accept your sign-in for this, so nothing was changed. Reload the page and try again. If it keeps happening, report it.';
// No way to ask, as in a test or before the client exists.
const SESSION_UNKNOWN='Satchel could not confirm it was you, so nothing was changed. Reload the page. If it asks you to sign in, do that, then try again.';
// The request reached Satchel as a connected app. The web app never signs in
// as one, so this is a fault, and signing in again would not help.
const APP_TOKEN='Only you can do this, from the Satchel web app, and this request did not come from your sign-in there. Nothing was changed. Reload the page and try again. If it keeps happening, report it.';

// Messages that carry a value, or come from Supabase rather than from us.
export const raisedPatterns=[
  // Supabase's storage.protect_delete trigger. delete_topic and delete_task
  // remove uploaded files with a plain delete on storage.objects, which this
  // trigger refuses. The whole delete rolls back, so nothing is gone.
  [/^Direct deletion from storage tables is not allowed/,'Satchel could not remove the uploaded files that go with this, so nothing was deleted. '+SATCHEL_FAULT],
  [/^Repository is linked to \d+ topics/,reasonText['invalid:repository_ambiguous']],
  // A row-level security refusal: signed in, but the row is not one this
  // account may write. Usually the topic or task it hangs off is gone.
  [/row-level security/i,'Satchel would not save this here. The topic or task it belongs to may be gone. Reload the page. Nothing was saved.'],
  // PostgREST and Postgres saying the token itself is expired or unreadable.
  // That is the session, with no guessing.
  [/\bjwt\b.*expired|expired.*\bjwt\b|^JWSError|^JWT|Invalid Compact JWS/i,SESSION],
];

// private.schedule_problem returns a sentence written for the person, and the
// schedule routines raise it as-is with `raise exception '%'`. Only these
// starts pass through, so a raw database message never can.
export const personSentences=/^(Choose at least one day|Choose one time|Two passes need|That time zone is not recognised)/;

// Constraints a web form can break, where the value came from the person.
export const constraintText={
  memories_statement_check:'A memory is 1 to 500 characters. Shorten it and try again.',
  memories_source_check:'The source is at most 4000 characters. Shorten it and try again.',
  memories_name_check:'A handle is at most 100 characters. Shorten it and try again.',
  memories_more_info_check:'More info is at most 40,000 characters. Shorten it and try again.',
  memories_scope_name:'That handle is already used by another memory in this scope. Choose a different one.',
  memories_personal_name:'That handle is already used by another of your “For me” memories. Choose a different one.',
  topics_name_check:'A topic name is 1 to 100 characters. Shorten it and try again.',
  topics_brief_check:'A topic brief is at most 1000 characters. Shorten it and try again.',
  topics_slug_check:SHORT_NAME_SHAPE,
  topics_owner_slug:SHORT_NAME_TAKEN,
  topic_repositories_repository_check:'Enter a GitHub repository as owner/name, like acme/web.',
  tasks_title_check:'A task title is 1 to 200 characters. Shorten it and try again.',
  tasks_outcome_check:'The outcome is at most 1000 characters. Shorten it and try again.',
  tasks_why_check:'Why is at most 4000 characters. Shorten it and try again.',
  tasks_next_action_check:'The next action is at most 1000 characters. Shorten it and try again.',
  tasks_done_when_check:'Done when has at most 20 lines, and none of them empty. Remove some and try again.',
  tasks_done_when_check1:'Done when is at most 10,000 characters in total. Shorten it and try again.',
  tasks_priority_check:'Pick a priority from the list and try again.',
  tasks_status_check:'That state is not one Satchel knows. Reload the page and pick again.',
  tasks_check:'A blocked task needs a reason of at most 2000 characters, and any other state has none.',
  tasks_slug_check:SHORT_NAME_SHAPE,
  tasks_owner_slug:SHORT_NAME_TAKEN,
  task_dependencies_check:'A task can’t wait on itself. Pick a different task.',
  task_parent_edges_check:'A task can’t be its own parent. Pick a different parent.',
  task_updates_body_check:'A comment is 1 to 4000 characters. Shorten it and try again.',
  task_updates_next_action_check:'The next action is at most 1000 characters. Shorten it and try again.',
  task_updates_check:'A blocked task needs a reason of at most 2000 characters. Shorten it and try again.',
  task_updates_completed_check:'An update lists at most 50 things done. Remove some and try again.',
  task_updates_decisions_check:'An update lists at most 50 decisions. Remove some and try again.',
  task_updates_remaining_check:'An update lists at most 50 things left. Remove some and try again.',
  task_updates_blockers_check:'An update lists at most 50 blockers. Remove some and try again.',
  task_updates_completed_check1:'Things done are at most 20,000 characters in total. Shorten them and try again.',
  task_updates_decisions_check1:'Decisions are at most 20,000 characters in total. Shorten them and try again.',
  task_updates_remaining_check1:'Things left are at most 20,000 characters in total. Shorten them and try again.',
  task_updates_blockers_check1:'Blockers are at most 20,000 characters in total. Shorten them and try again.',
  task_handoffs_next_action_check:'A handoff needs a next action of 1 to 1000 characters.',
  task_handoffs_summary_check:'A handoff summary is at most 4000 characters. Shorten it and try again.',
  task_handoffs_completed_check:'A handoff lists at most 50 things done. Remove some and try again.',
  task_handoffs_decisions_check:'A handoff lists at most 50 decisions. Remove some and try again.',
  task_handoffs_remaining_check:'A handoff lists at most 50 things left. Remove some and try again.',
  task_handoffs_blockers_check:'A handoff lists at most 50 blockers. Remove some and try again.',
  task_resources_label_check:'A label is 1 to 200 characters. Shorten it and try again.',
  task_resources_check:'A link must start with https:// and have no spaces.',
};

// Sentences the repositories throw as a plain Error rather than a Sentence.
// They are ours and already written for the person, so they pass through.
const PLAIN=['Files are limited','The uploaded file did not pass','Enter a GitHub repository'];

// The load fallback. LoadError shows its own connection wording in its place.
export const LOAD_FAILED='Your book could not be loaded. Check your connection and reload.';
const LOAD=LOAD_FAILED;
const tail=operation=>operation==='save'?' Your draft is still here.':'';

function fromConstraint(code,name,operation) {
  if(constraintText[name])return constraintText[name]+(operation==='save'?' Nothing was saved yet.':'');
  if(code==='23505'&&/(_pkey|_id_key)$/.test(name))return 'Satchel already has a record with this id. Reload the page to see whether your change was saved.';
  if(code==='23503')return 'Something this points at was deleted. Reload the page and try again. Nothing was saved.';
  if(code==='23505')return 'That name is already used here. Choose a different one.'+tail(operation);
  return 'One of the values breaks a rule Satchel keeps, so nothing was saved. Check the fields and try again.'+tail(operation);
}

const constraintName=message=>/constraint "([^"]+)"/.exec(message)?.[1];

// Supabase Auth errors carry a code from GoTrue. These all mean the session
// itself is gone.
const AUTH_GONE=new Set(['session_not_found','session_expired','refresh_token_not_found','refresh_token_already_used','bad_jwt','no_authorization','user_not_found']);

function fromAuth(error) {
  if(error.name==='AuthSessionMissingError'||AUTH_GONE.has(error.code)||error.status===401)return SESSION;
  return 'Satchel’s sign-in service did not answer as expected, so nothing was changed. Reload the page and try again.';
}

function fromStorage(error,operation) {
  const message=String(error.message??'');
  const status=Number(error.status??error.statusCode)||0;
  const code=String(error.code??error.statusCode??'');
  if(code==='InvalidJWT'||status===401||/jwt|jws|exp claim/i.test(message))return SESSION;
  if(/bucket not found/i.test(message))return 'File storage is not set up on this Satchel. Contact the instance owner.';
  if(status===413||code==='EntityTooLarge'||/maximum allowed size|too large/i.test(message))return 'That file is too big for storage. Files are limited to 6 MB.';
  if(status===409||code==='Duplicate'||/already exists/i.test(message))return 'A file is already stored for this upload. Reload the task to see whether it finished.';
  if(status===404||code==='NoSuchKey'||/not found/i.test(message))return 'That file is no longer in storage. Reload the task to see what is still attached.';
  if(status===403||code==='AccessDenied'||/row-level security|unauthorized/i.test(message))
    return 'File storage refused this file. The task or its upload may be gone. Reload the task and try again.';
  return operation==='load'?LOAD:'File storage did not answer. Check your connection, reload the task, and try again.';
}

const field=(error,key)=>error&&typeof error==='object'&&typeof error[key]==='string'?error[key]:'';

/** The reason a routine put in the hint, without the satchel: prefix, or ''. */
export function reasonOf(error) {
  const hint=field(error,'hint');
  return hint.startsWith('satchel:')?hint.slice('satchel:'.length):'';
}

/** True when the reason given could be a session that has gone, and only the
 *  auth client can say whether it has. */
export function needsSessionCheck(error) {
  if(error instanceof Sentence)return false;
  const reason=reasonOf(error);
  if(reason)return reason===SESSION_REASON;
  const message=field(error,'message');
  return sessionGuards.has(message)||ANON.test(message);
}

/** @param {unknown} error @param {'load'|'save'|'action'} [operation]
 *  @param {boolean} [signedIn] what the auth client said, when asked */
export function errorMessage(error,operation='save',signedIn) {
  if(error instanceof Sentence)return error.message;
  if(error instanceof Error&&!('code' in error)&&PLAIN.some(start=>error.message.startsWith(start)))return error.message;
  const object=error&&typeof error==='object'?error:{};
  const code=typeof object.code==='string'?object.code:'';
  const message=typeof object.message==='string'?object.message:'';

  if(code==='SATCHEL_TIMEOUT')return operation==='load'
    ?'Loading took too long. Reload to try again.'
    :operation==='save'
      ?'The request took too long. Your draft is still here. Reload to check whether the change reached your book before retrying.'
      :'The request took too long. Reload to check whether it went through before you try again.';
  if(object.__isAuthError)return fromAuth(object);
  if(object.__isStorageError)return fromStorage(object,operation);

  // PostgREST's own codes come before the message: they are about the request,
  // not about anything a routine said.
  if(code==='PGRST301'||code==='PGRST302'||code==='PGRST303')return SESSION;
  if(code==='PGRST205'||code==='PGRST202'||code==='42P01'||code==='42883')
    return 'This Satchel instance needs its database setup completed. Contact the instance owner, then reload.';
  if(code==='PGRST116')return operation==='load'
    ?'That is no longer here. It may have been deleted or moved. Go back and reload.'
    :'Satchel expected a record back and got none. Reload the page to check whether the change happened.';

  const session=()=>signedIn===false?SESSION:signedIn===true?SESSION_REFUSED:SESSION_UNKNOWN;
  // The reason our routine gave. A reason this build has no line for came
  // from a newer database, and falls through to the sentence and the code.
  const reason=reasonOf(object);
  if(reason===SESSION_REASON)return session();
  if(reason===APP_TOKEN_REASON)return APP_TOKEN;
  if(reason===PERSON_REASON&&message)return message;
  if(Object.hasOwn(reasonText,reason))return reasonText[reason];

  if(code==='22023'&&personSentences.test(message))return message;
  if(sessionGuards.has(message)||ANON.test(message))return session();
  const raised=raisedText[message]??raisedPatterns.find(([pattern])=>pattern.test(message))?.[1];
  if(raised)return raised;
  const name=constraintName(message);
  if(name&&/^23/.test(code))return fromConstraint(code,name,operation);

  if(code==='22P02')return operation==='load'
    ?'That link points at something that does not exist. Check the address, or go back and pick it from the list.'
    :'Satchel could not read one of the values, so nothing was saved. Reload the page and try again.';
  if(code==='23505')return 'That name is already used here. Choose a different one.'+tail(operation);
  if(code==='23514')return 'One of the values breaks a rule Satchel keeps, so nothing was saved. Check the fields and try again.'+tail(operation);
  if(code==='P0002')return operation==='load'
    ?'That is no longer here. It may have been deleted or moved. Go back and reload.'
    :'That is no longer here. It may have been deleted or moved, so nothing was changed. Reload the page.';
  if(code==='PT409'||code==='40001')return 'This record changed elsewhere or conflicts with an earlier save. Reload to see the latest version.'
    +(operation==='save'?' Your draft is still here; discard it before starting a fresh correction.':' Nothing was changed.');
  // A refusal nobody wrote a line for. It is not the session: those all have
  // their own text above. So it says what is true and does not send the
  // person to a sign-in page that will not help.
  if(code==='42501')return 'Satchel refused this, so nothing was changed. Reload the page and try again. If it keeps happening, report it.';
  if(/^2[23]/.test(code))return 'Satchel could not accept one of the values, so nothing was saved. Check the fields and try again.'+tail(operation);

  if(operation==='load')return LOAD;
  return operation==='save'
    ?'Satchel could not complete that request. Check your connection and retry. Your draft is still here.'
    :'Satchel could not complete that. Check your connection, reload to see whether it went through, then try again.';
}
