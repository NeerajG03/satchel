import {useEffect,useMemo,useState,type FormEvent} from 'react';
import type {SupabaseClient} from '@supabase/supabase-js';
import {errorMessage} from '../../client';
import {createProjectRepository,type Project} from '../projects/repository';
import {createTaskRepository} from './repository';
import {EMPTY_TASK,replaceTask,type TaskDetail,type TaskDraft,type TaskStatus,type TaskSummary} from './model';

const STATES:TaskStatus[]=['inbox','ready','in_progress','blocked','done'];
const lines=(value:string)=>value.split('\n').map(line=>line.trim()).filter(Boolean);
const resourceIds=(form:FormData)=>form.getAll('resource_id').map(String);

export function TaskWorkspace({db}:{db:SupabaseClient}) {
  const projectStore=useMemo(()=>createProjectRepository(db),[db]);
  const taskStore=useMemo(()=>createTaskRepository(db),[db]);
  const [projects,setProjects]=useState<Project[]>([]);
  const [projectId,setProjectId]=useState<string|null>(null);
  const [tasks,setTasks]=useState<TaskSummary[]>([]);
  const [selected,setSelected]=useState<TaskDetail|null>(null);
  const [draft,setDraft]=useState<TaskDraft>(EMPTY_TASK);
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const [taskId,setTaskId]=useState(()=>crypto.randomUUID());
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [blockedReason,setBlockedReason]=useState('');
  const [query,setQuery]=useState('');
  const [statusFilter,setStatusFilter]=useState<TaskStatus|'all'>('all');
  const [actionableOnly,setActionableOnly]=useState(false);

  useEffect(()=>{let active=true;setLoading(true);
    projectStore.list().then(items=>{if(active)setProjects(items);})
      .catch(reason=>{if(active)setError(errorMessage(reason,'load'));})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[projectStore]);
  useEffect(()=>{let active=true;
    setLoading(true);setError('');setSelected(null);
    taskStore.list(projectId).then(items=>{if(active)setTasks(items);})
      .catch(reason=>{if(active)setError(errorMessage(reason,'load'));})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[projectId,taskStore]);

  async function run(action:()=>Promise<void>) {
    setBusy(true);setError('');setNotice('');
    try{await action();return true;}catch(reason){setError(errorMessage(reason));return false;}finally{setBusy(false);}
  }
  function changeDraft(next:TaskDraft) {setDraft(next);setRequestId(crypto.randomUUID());}
  function resetDraft() {setDraft(EMPTY_TASK);setSelected(null);setRequestId(crypto.randomUUID());setTaskId(crypto.randomUUID());}
  async function open(summary:TaskSummary) {await run(async()=>{const task=await taskStore.read(summary.project_id,summary.id);setSelected(task);setDraft(task);});}
  async function save(event:FormEvent) {event.preventDefault();
    await run(async()=>{const task=selected?await taskStore.update(selected,requestId,draft):await taskStore.create(projectId,taskId,requestId,draft);
      const refreshed=await taskStore.read(task.project_id,task.id);setTasks(refreshed.scope_tasks);resetDraft();setNotice(selected?'Task updated.':'Task captured.');});
  }
  async function transition(status:TaskStatus) {if(!selected)return;const reason=status==='blocked'?blockedReason:'';
    if(status==='blocked'&&!reason.trim())return;
    await run(async()=>{const changed=await taskStore.transition(selected,crypto.randomUUID(),status,reason);const task=await taskStore.read(changed.project_id,changed.id);setSelected(task);setDraft(task);setTasks(task.scope_tasks);setBlockedReason('');setNotice(`Moved to ${status.replace('_',' ')}.`);});
  }
  async function refreshPlanning(taskId:string,message:string) {
    const task=await taskStore.read(projectId,taskId);setSelected(task);setDraft(task);setTasks(task.scope_tasks);setNotice(message);
  }
  async function setParent(event:FormEvent<HTMLFormElement>) {event.preventDefault();if(!selected)return;
    const parentId=String(new FormData(event.currentTarget).get('parent_id')??'')||null;
    await run(async()=>{const result=await taskStore.setParent(selected,crypto.randomUUID(),parentId);await refreshPlanning(result.task.id,'Task hierarchy updated.');});
  }
  async function addDependency(event:FormEvent<HTMLFormElement>) {event.preventDefault();if(!selected)return;
    const element=event.currentTarget;const dependencyId=String(new FormData(element).get('dependency_id')??'');if(!dependencyId)return;
    await run(async()=>{const result=await taskStore.addDependency(selected,crypto.randomUUID(),dependencyId);await refreshPlanning(result.task.id,'Dependency added.');element.reset();});
  }
  async function removeDependency(dependencyId:string) {if(!selected)return;
    await run(async()=>{const result=await taskStore.removeDependency(selected,crypto.randomUUID(),dependencyId);await refreshPlanning(result.task.id,'Dependency removed.');});
  }
  async function addHandoff(event:FormEvent<HTMLFormElement>) {event.preventDefault();if(!selected)return;
    const element=event.currentTarget;const form=new FormData(element);const summary=String(form.get('summary')??'');const nextAction=String(form.get('next_action')??'');
    const status=String(form.get('status')??'') as TaskStatus|'';const handoffBlockedReason=String(form.get('blocked_reason')??'');
    if(status==='blocked'&&!handoffBlockedReason.trim()){setError('A blocked handoff requires a blocker.');return;}
    await run(async()=>{const result=await taskStore.handoff(selected,crypto.randomUUID(),crypto.randomUUID(),{
      summary,completed:lines(String(form.get('completed')??'')),decisions:lines(String(form.get('decisions')??'')),
      validation:lines(String(form.get('validation')??'')).map(note=>({note})),remaining:lines(String(form.get('remaining')??'')),
      blockers:lines(String(form.get('blockers')??'')),nextAction,status:status||null,blockedReason:handoffBlockedReason,
      resourceIds:resourceIds(form),supersedesIds:form.getAll('supersedes_id').map(String),
    });const task=await taskStore.read(selected.project_id,result.task.id);setSelected(task);setDraft(task);setTasks(task.scope_tasks);setNotice('Handoff recorded.');element.reset();});
  }
  async function addComment(event:FormEvent<HTMLFormElement>) {event.preventDefault();if(!selected)return;
    const element=event.currentTarget;const form=new FormData(element);
    await run(async()=>{await taskStore.comment(selected,crypto.randomUUID(),crypto.randomUUID(),String(form.get('body')??''),resourceIds(form));
      const task=await taskStore.read(selected.project_id,selected.id);setSelected(task);setDraft(task);setTasks(items=>replaceTask(items,task));setNotice('Comment added.');element.reset();});
  }
  async function addProgress(event:FormEvent<HTMLFormElement>) {event.preventDefault();if(!selected)return;
    const element=event.currentTarget;const form=new FormData(element);const status=String(form.get('status')??'') as TaskStatus|'';
    const progressBlockedReason=String(form.get('blocked_reason')??'');
    if(status==='blocked'&&!progressBlockedReason.trim()){setError('A blocked progress update requires a blocker.');return;}
    await run(async()=>{const result=await taskStore.progress(selected,crypto.randomUUID(),crypto.randomUUID(),{
      summary:String(form.get('summary')??''),completed:lines(String(form.get('completed')??'')),
      decisions:lines(String(form.get('decisions')??'')),remaining:lines(String(form.get('remaining')??'')),
      blockers:lines(String(form.get('blockers')??'')),nextAction:String(form.get('next_action')??''),
      status:status||null,blockedReason:progressBlockedReason,resourceIds:resourceIds(form),
    });const task=await taskStore.read(selected.project_id,result.task.id);setSelected(task);setDraft(task);setTasks(task.scope_tasks);setNotice('Progress recorded.');element.reset();});
  }
  async function addLink(event:FormEvent<HTMLFormElement>) {event.preventDefault();if(!selected)return;const element=event.currentTarget;const form=new FormData(element);
    await run(async()=>{const result=await taskStore.addLink(selected,crypto.randomUUID(),crypto.randomUUID(),String(form.get('label')),String(form.get('url')));
      const task=await taskStore.read(selected.project_id,result.task.id);setSelected(task);setDraft(task);setTasks(items=>replaceTask(items,result.task));setNotice('Link attached.');element.reset();});
  }
  async function upload(event:FormEvent<HTMLFormElement>) {event.preventDefault();if(!selected)return;const element=event.currentTarget;const form=new FormData(element);const file=form.get('file');if(!(file instanceof File)||!file.size)return;
    await run(async()=>{const result=await taskStore.upload(selected,crypto.randomUUID(),crypto.randomUUID(),String(form.get('label')),file);
      const task=await taskStore.read(selected.project_id,result.task.id);setSelected(task);setDraft(task);setTasks(items=>replaceTask(items,result.task));setNotice('File uploaded and verified.');element.reset();});
  }
  async function exportProject() {await run(async()=>{const count=await taskStore.exportProject(projectId);setNotice(`Exported the database manifest${count?` and ${count} stored file${count===1?'':'s'}`:''}.`);});}

  const project=projects.find(item=>item.id===projectId);
  const visibleTasks=tasks.filter(task=>(statusFilter==='all'||task.status===statusFilter)
    &&(!actionableOnly||task.actionable)
    &&(!query.trim()||`${task.title} ${task.next_action}`.toLowerCase().includes(query.trim().toLowerCase())));
  const parent=selected?.scope_tasks.find(task=>task.id===selected.parent_id);
  const children=selected?.scope_tasks.filter(task=>task.parent_id===selected.id)??[];
  const dependencies=selected?.scope_tasks.filter(task=>selected.dependency_ids.includes(task.id))??[];
  const dependents=selected?.scope_tasks.filter(task=>task.dependency_ids.includes(selected.id))??[];
  const activity=selected?[...selected.updates.map(update=>({kind:'update' as const,id:update.id,at:update.created_at,update})),
    ...selected.handoffs.map(handoff=>({kind:'handoff' as const,id:handoff.id,at:handoff.created_at,handoff}))]
    .sort((a,b)=>b.at.localeCompare(a.at)):[];
  async function openRelated(id:string) {if(!selected)return;const task=selected.scope_tasks.find(item=>item.id===id);if(task)await open(task);}
  return <div className="task-layout">
    <aside><div className="eyebrow">TASK PROJECT</div><nav aria-label="Task projects">
      <button aria-current={projectId===null?'page':undefined} disabled={busy}
        onClick={()=>setProjectId(null)}>For me</button>
      {projects.map(item=><button key={item.id} aria-current={item.id===projectId?'page':undefined} disabled={busy}
        onClick={()=>setProjectId(item.id)}>{item.name}</button>)}
    </nav></aside>
    <section className="book tasks"><div className="book-heading"><div><div className="eyebrow">{project?.name??'FOR ME'}</div><h1>Continue.</h1></div>
      <button className="quiet" disabled={busy} onClick={()=>void exportProject()}>Export {projectId===null?'personal tasks':'project'}</button></div>
      <p className="muted">See what is moving, what is blocked, and the exact next action.</p>
      {error&&<p className="notice error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
      {selected?<>
        <button className="quiet" disabled={busy} onClick={resetDraft}>← Back to task list</button>
        <form className="composer" onSubmit={save}><h2>Edit task</h2>
          <label>Title<input required maxLength={200} value={draft.title} disabled={busy} onChange={event=>changeDraft({...draft,title:event.target.value})}/></label>
          <label>Outcome<textarea maxLength={1000} value={draft.outcome} disabled={busy} onChange={event=>changeDraft({...draft,outcome:event.target.value})}/></label>
          <label>Why<textarea maxLength={4000} value={draft.why} disabled={busy} onChange={event=>changeDraft({...draft,why:event.target.value})}/></label>
          <label>Done when <span className="muted">(one per line)</span><textarea value={draft.done_when.join('\n')} disabled={busy} onChange={event=>changeDraft({...draft,done_when:lines(event.target.value)})}/></label>
          <label>Next action<textarea maxLength={1000} value={draft.next_action} disabled={busy} onChange={event=>changeDraft({...draft,next_action:event.target.value})}/></label>
          <label>Priority<select value={draft.priority} disabled={busy} onChange={event=>changeDraft({...draft,priority:event.target.value as TaskDraft['priority']})}>
            {(['low','medium','high','urgent'] as const).map(value=><option key={value}>{value}</option>)}</select></label>
          <div className="compose-actions"><span className="fine muted">Revision {selected.revision} · {selected.status.replace('_',' ')}</span><button className="primary" disabled={busy||!draft.title.trim()}>Save task</button></div>
        </form>
        <section className="task-section"><h2>Move task</h2><label>Blocker <span className="muted">(required only when moving to blocked)</span><input maxLength={2000} value={blockedReason} disabled={busy} onChange={event=>setBlockedReason(event.target.value)} placeholder={selected.blocked_reason||'What is preventing progress?'}/></label>
          <div className="state-actions">{STATES.map(state=><button key={state} disabled={busy||state===selected.status||(state==='blocked'&&!blockedReason.trim())} onClick={()=>void transition(state)}>{state.replace('_',' ')}</button>)}</div></section>
        <section className="task-section"><h2>Planning</h2>
          <p className="muted">Hierarchy groups work. Dependencies determine whether this task is actionable.</p>
          <p><strong>{selected.actionable?'Actionable now':'Not actionable'}</strong>{selected.blocked_by_ids.length>0&&` · waiting on ${selected.blocked_by_ids.length} task${selected.blocked_by_ids.length===1?'':'s'}`}</p>
          {parent&&<div className="relation-block"><span className="eyebrow">PARENT</span><button className="relation-link" disabled={busy} onClick={()=>void openRelated(parent.id)}>{parent.title}</button></div>}
          <form className="inline-form relation-form" onSubmit={setParent}><label>Parent task<select key={selected.parent_id??'root'} name="parent_id" defaultValue={selected.parent_id??''} disabled={busy}><option value="">No parent</option>{selected.scope_tasks.filter(task=>task.id!==selected.id).map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label><button disabled={busy}>Set parent</button></form>
          {children.length>0&&<div className="relation-list"><h3>Child tasks</h3>{children.map(task=><button className="relation-link" key={task.id} disabled={busy} onClick={()=>void openRelated(task.id)}>{task.title} <span className="fine muted">· {task.status.replace('_',' ')}</span></button>)}</div>}
          <div className="relation-list"><h3>Depends on</h3>{dependencies.length===0?<p className="muted">No dependencies.</p>:dependencies.map(task=><div className="resource-row" key={task.id}><button className="relation-link" disabled={busy} onClick={()=>void openRelated(task.id)}>{task.title}{selected.blocked_by_ids.includes(task.id)&&<span className="fine muted"> · unfinished</span>}</button><button className="quiet" disabled={busy} onClick={()=>void removeDependency(task.id)}>Remove</button></div>)}</div>
          <form className="inline-form relation-form" onSubmit={addDependency}><label>Add dependency<select name="dependency_id" defaultValue="" required disabled={busy}><option value="" disabled>Select a task</option>{selected.scope_tasks.filter(task=>task.id!==selected.id&&!selected.dependency_ids.includes(task.id)).map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label><button disabled={busy}>Add dependency</button></form>
          {dependents.length>0&&<div className="relation-list"><h3>Blocks</h3>{dependents.map(task=><button className="relation-link" key={task.id} disabled={busy} onClick={()=>void openRelated(task.id)}>{task.title} <span className="fine muted">· {task.status.replace('_',' ')}</span></button>)}</div>}
        </section>
        <section className="task-section"><h2>Resources</h2>{selected.resources?.map(resource=><div className="resource-row" key={resource.id}><span>{resource.label} <span className="fine muted">· {resource.upload_status}</span></span>
          {resource.kind==='external_url'?<a href={resource.external_url??'#'} target="_blank" rel="noreferrer">Open ↗</a>:resource.upload_status==='verified'?<button className="quiet" onClick={()=>void run(()=>taskStore.download(resource))}>Download</button>:null}</div>)}
          <form className="inline-form" onSubmit={addLink}><label>Link label<input name="label" required maxLength={200} disabled={busy}/></label><label>HTTPS URL<input name="url" type="url" required pattern="https://.*" disabled={busy}/></label><button disabled={busy}>Attach link</button></form>
          <form className="inline-form" onSubmit={upload}><label>File label<input name="label" maxLength={200} disabled={busy}/></label><label>File <span className="muted">(max 6 MB)</span><input name="file" type="file" required disabled={busy}/></label><button disabled={busy}>Upload file</button></form>
        </section>
        <section className="task-section"><h2>Updates & comments</h2>
          <form key={`progress-${selected.id}-${selected.revision}`} onSubmit={addProgress}><h3>Progress update</h3>
            <label>Summary<textarea name="summary" required maxLength={4000} disabled={busy}/></label>
            <label>Completed <span className="muted">(one per line)</span><textarea name="completed" disabled={busy}/></label>
            <label>Decisions <span className="muted">(one per line)</span><textarea name="decisions" disabled={busy}/></label>
            <label>Remaining <span className="muted">(one per line)</span><textarea name="remaining" disabled={busy}/></label>
            <label>Blockers <span className="muted">(one per line)</span><textarea name="blockers" disabled={busy}/></label>
            <label>Next action<textarea name="next_action" maxLength={1000} defaultValue={selected.next_action} disabled={busy}/></label>
            <label>Move task <select name="status" defaultValue="" disabled={busy}><option value="">Keep current state</option>{STATES.map(state=><option key={state} value={state}>{state.replace('_',' ')}</option>)}</select></label>
            <label>Blocked reason <span className="muted">(required when moving to blocked)</span><input name="blocked_reason" maxLength={2000} disabled={busy}/></label>
            {!!selected.resources?.length&&<fieldset className="resource-choices"><legend>Reference resources</legend>{selected.resources.filter(resource=>resource.upload_status==='verified').map(resource=><label key={resource.id}><input type="checkbox" name="resource_id" value={resource.id} disabled={busy}/>{resource.label}</label>)}</fieldset>}
            <button className="primary" disabled={busy}>Record progress</button>
          </form>
          <form className="comment-form" onSubmit={addComment}><h3>Comment</h3><label>Comment<textarea name="body" required maxLength={4000} disabled={busy}/></label>
            {!!selected.resources?.length&&<fieldset className="resource-choices"><legend>Reference resources</legend>{selected.resources.filter(resource=>resource.upload_status==='verified').map(resource=><label key={resource.id}><input type="checkbox" name="resource_id" value={resource.id} disabled={busy}/>{resource.label}</label>)}</fieldset>}
            <button disabled={busy}>Add comment</button>
          </form>
          <div className="task-timeline">{activity.length===0?<p className="muted">No activity recorded yet.</p>:activity.map(item=>item.kind==='update'?(()=>{const update=item.update;const linked=(selected.update_resource_refs??[]).filter(ref=>ref.update_id===update.id).map(ref=>selected.resources.find(resource=>resource.id===ref.resource_id)).filter(Boolean);return <article key={`update-${update.id}`}>
            <div className="task-card-heading"><h3>{update.kind==='progress'?'Progress update':'Comment'}</h3>{update.status&&<span className={`task-state ${update.status}`}>{update.status.replace('_',' ')}</span>}</div>
            <p>{update.body}</p>{update.completed.length>0&&<p><strong>Completed:</strong> {update.completed.join(' · ')}</p>}{update.decisions.length>0&&<p><strong>Decisions:</strong> {update.decisions.join(' · ')}</p>}{update.remaining.length>0&&<p><strong>Remaining:</strong> {update.remaining.join(' · ')}</p>}{update.blockers.length>0&&<p><strong>Blockers:</strong> {update.blockers.join(' · ')}</p>}{update.next_action&&<p><strong>Next:</strong> {update.next_action}</p>}
            {linked.length>0&&<p className="fine">Resources: {linked.map(resource=>resource?.label).join(', ')}</p>}<p className="fine muted">{new Date(update.created_at).toLocaleString()} · {update.created_by}</p>
          </article>;})():(()=>{const handoff=item.handoff;return <article key={`handoff-${handoff.id}`}><h3>Handoff{handoff.summary?`: ${handoff.summary}`:''}</h3>{handoff.completed.length>0&&<p><strong>Completed:</strong> {handoff.completed.join(' · ')}</p>}{handoff.decisions.length>0&&<p><strong>Decisions:</strong> {handoff.decisions.join(' · ')}</p>}{handoff.validation.length>0&&<p><strong>Validation:</strong> {handoff.validation.map(value=>String(value.note??JSON.stringify(value))).join(' · ')}</p>}{handoff.remaining.length>0&&<p><strong>Remaining:</strong> {handoff.remaining.join(' · ')}</p>}{handoff.blockers.length>0&&<p><strong>Blockers:</strong> {handoff.blockers.join(' · ')}</p>}<p><strong>Next:</strong> {handoff.next_action}</p><p className="fine muted">{new Date(handoff.created_at).toLocaleString()} · {handoff.created_by}</p></article>;})())}</div>
        </section>
        <section className="task-section"><h2>Record handoff</h2><form key={`handoff-${selected.id}-${selected.revision}`} onSubmit={addHandoff}>
          <label>Summary<textarea name="summary" maxLength={4000} disabled={busy}/></label><label>Completed <span className="muted">(one per line)</span><textarea name="completed" disabled={busy}/></label>
          <label>Decisions <span className="muted">(one per line)</span><textarea name="decisions" disabled={busy}/></label><label>Validation performed <span className="muted">(one per line)</span><textarea name="validation" disabled={busy}/></label>
          <label>Remaining <span className="muted">(one per line)</span><textarea name="remaining" disabled={busy}/></label><label>Blockers <span className="muted">(one per line)</span><textarea name="blockers" disabled={busy}/></label><label>Next action<textarea name="next_action" required maxLength={1000} defaultValue={selected.next_action} disabled={busy}/></label>
          <label>Move task <select name="status" defaultValue="" disabled={busy}><option value="">Keep current state</option>{STATES.map(state=><option key={state} value={state}>{state.replace('_',' ')}</option>)}</select></label><label>Blocked reason <span className="muted">(required when moving to blocked)</span><input name="blocked_reason" maxLength={2000} disabled={busy}/></label>
          {!!selected.resources?.length&&<fieldset className="resource-choices"><legend>Reference resources</legend>{selected.resources.filter(resource=>resource.upload_status==='verified').map(resource=><label key={resource.id}><input type="checkbox" name="resource_id" value={resource.id} disabled={busy}/>{resource.label}</label>)}</fieldset>}
          {!!selected.handoffs?.length&&<fieldset className="resource-choices"><legend>Supersedes earlier handoff</legend>{selected.handoffs.map(handoff=><label key={handoff.id}><input type="checkbox" name="supersedes_id" value={handoff.id} disabled={busy}/>{handoff.summary||new Date(handoff.created_at).toLocaleString()}</label>)}</fieldset>}
          <button className="primary" disabled={busy}>Save handoff</button></form>
        </section>
        <details className="task-section history"><summary>Technical history · {selected.events.length} events</summary>{[...selected.events].reverse().map(event=><div className="event-row" key={event.id}><span>{event.event_type.replaceAll('_',' ')}</span><span className="fine muted">revision {event.to_revision} · {new Date(event.created_at).toLocaleString()}</span></div>)}</details>
      </>:<>
        <div className="task-toolbar"><label>Search tasks<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Title or next action"/></label><label>Status<select value={statusFilter} onChange={event=>setStatusFilter(event.target.value as TaskStatus|'all')}><option value="all">All states</option>{STATES.map(state=><option key={state} value={state}>{state.replace('_',' ')}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={actionableOnly} onChange={event=>setActionableOnly(event.target.checked)}/>Actionable only</label></div>
        <form className="composer" onSubmit={save}><h2>Capture a task</h2><label>Title<input required maxLength={200} value={draft.title} disabled={busy} onChange={event=>changeDraft({...draft,title:event.target.value})}/></label>
          <label>Outcome <span className="muted">(optional)</span><textarea maxLength={1000} value={draft.outcome} disabled={busy} onChange={event=>changeDraft({...draft,outcome:event.target.value})}/></label>
          <label>Next action <span className="muted">(optional)</span><textarea maxLength={1000} value={draft.next_action} disabled={busy} onChange={event=>changeDraft({...draft,next_action:event.target.value})}/></label>
          <label>Priority<select value={draft.priority} disabled={busy} onChange={event=>changeDraft({...draft,priority:event.target.value as TaskDraft['priority']})}>{(['low','medium','high','urgent'] as const).map(value=><option key={value}>{value}</option>)}</select></label>
          <button className="primary" disabled={busy||!draft.title.trim()}>Capture task</button></form>
        {loading?<p role="status">Loading tasks…</p>:tasks.length===0?<div className="empty"><h2>No tasks yet.</h2><p>Capture the next thing worth carrying forward.</p></div>:visibleTasks.length===0?<div className="empty"><h2>No matching tasks.</h2><p>Clear a filter to see the rest of this scope.</p></div>:
          <div className="task-list">{visibleTasks.map(task=><article key={task.id}><div className="task-card-heading"><h2>{task.title}</h2><span className={`task-state ${task.status}`}>{task.status.replace('_',' ')}</span></div>
            <p>{task.next_action||'No next action yet.'}</p>{task.blocked_reason&&<p className="notice">Blocked: {task.blocked_reason}</p>}{task.blocked_by_ids.length>0&&<p className="notice">Waiting on {task.blocked_by_ids.length} task{task.blocked_by_ids.length===1?'':'s'}.</p>}
            <div className="memory-meta"><span className="fine muted">{task.priority} · revision {task.revision}{task.parent_id?` · child of ${tasks.find(item=>item.id===task.parent_id)?.title??'task'}`:''}{task.child_count?` · ${task.child_count} child${task.child_count===1?'':'ren'}`:''}{task.actionable?' · actionable':''}</span><button className="quiet" disabled={busy} onClick={()=>void open(task)}>Open</button></div></article>)}</div>}
      </>}
    </section>
  </div>;
}
