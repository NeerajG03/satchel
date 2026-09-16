import {useEffect,useMemo,useState,type FormEvent} from 'react';
import type {SupabaseClient} from '@supabase/supabase-js';
import {errorMessage} from '../../client';
import {createProjectRepository,type Project} from '../projects/repository';
import {createTaskRepository} from './repository';
import {EMPTY_TASK,replaceTask,type TaskDetail,type TaskDraft,type TaskStatus,type TaskSummary} from './model';

const STATES:TaskStatus[]=['inbox','ready','in_progress','blocked','done'];
const lines=(value:string)=>value.split('\n').map(line=>line.trim()).filter(Boolean);

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
      setTasks(items=>replaceTask(items,task));resetDraft();setNotice(selected?'Task updated.':'Task captured.');});
  }
  async function transition(status:TaskStatus) {if(!selected)return;const reason=status==='blocked'?blockedReason:'';
    if(status==='blocked'&&!reason.trim())return;
    await run(async()=>{const task=await taskStore.transition(selected,crypto.randomUUID(),status,reason);setSelected({...selected,...task});setDraft(task);setTasks(items=>replaceTask(items,task));setBlockedReason('');setNotice(`Moved to ${status.replace('_',' ')}.`);});
  }
  async function addHandoff(event:FormEvent<HTMLFormElement>) {event.preventDefault();if(!selected)return;
    const element=event.currentTarget;const form=new FormData(element);const summary=String(form.get('summary')??'');const nextAction=String(form.get('next_action')??'');
    await run(async()=>{const result=await taskStore.handoff(selected,crypto.randomUUID(),crypto.randomUUID(),{
      summary,completed:lines(String(form.get('completed')??'')),remaining:lines(String(form.get('remaining')??'')),nextAction,
    });const task=await taskStore.read(selected.project_id,result.task.id);setSelected(task);setDraft(task);setTasks(items=>replaceTask(items,result.task));setNotice('Handoff recorded.');element.reset();});
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
        <section className="task-section"><h2>Resources</h2>{selected.resources?.map(resource=><div className="resource-row" key={resource.id}><span>{resource.label} <span className="fine muted">· {resource.upload_status}</span></span>
          {resource.kind==='external_url'?<a href={resource.external_url??'#'} target="_blank" rel="noreferrer">Open ↗</a>:resource.upload_status==='verified'?<button className="quiet" onClick={()=>void run(()=>taskStore.download(resource))}>Download</button>:null}</div>)}
          <form className="inline-form" onSubmit={addLink}><label>Link label<input name="label" required maxLength={200} disabled={busy}/></label><label>HTTPS URL<input name="url" type="url" required pattern="https://.*" disabled={busy}/></label><button disabled={busy}>Attach link</button></form>
          <form className="inline-form" onSubmit={upload}><label>File label<input name="label" maxLength={200} disabled={busy}/></label><label>File <span className="muted">(max 6 MB)</span><input name="file" type="file" required disabled={busy}/></label><button disabled={busy}>Upload file</button></form>
        </section>
        <section className="task-section"><h2>Record handoff</h2><form onSubmit={addHandoff}>
          <label>Summary<textarea name="summary" maxLength={4000} disabled={busy}/></label><label>Completed <span className="muted">(one per line)</span><textarea name="completed" disabled={busy}/></label>
          <label>Remaining <span className="muted">(one per line)</span><textarea name="remaining" disabled={busy}/></label><label>Next action<textarea name="next_action" required maxLength={1000} defaultValue={selected.next_action} disabled={busy}/></label>
          <button className="primary" disabled={busy}>Save handoff</button></form>
          {[...(selected.handoffs??[])].reverse().map(handoff=><article key={handoff.id}><h3>{handoff.summary||'Handoff'}</h3><p>{handoff.next_action}</p><p className="fine muted">{new Date(handoff.created_at).toLocaleString()} · {handoff.created_by}</p></article>)}
        </section>
      </>:<>
        <form className="composer" onSubmit={save}><h2>Capture a task</h2><label>Title<input required maxLength={200} value={draft.title} disabled={busy} onChange={event=>changeDraft({...draft,title:event.target.value})}/></label>
          <label>Outcome <span className="muted">(optional)</span><textarea maxLength={1000} value={draft.outcome} disabled={busy} onChange={event=>changeDraft({...draft,outcome:event.target.value})}/></label>
          <label>Next action <span className="muted">(optional)</span><textarea maxLength={1000} value={draft.next_action} disabled={busy} onChange={event=>changeDraft({...draft,next_action:event.target.value})}/></label>
          <button className="primary" disabled={busy||!draft.title.trim()}>Capture task</button></form>
        {loading?<p role="status">Loading tasks…</p>:tasks.length===0?<div className="empty"><h2>No tasks yet.</h2><p>Capture the next thing worth carrying forward.</p></div>:
          <div className="task-list">{tasks.map(task=><article key={task.id}><div className="task-card-heading"><h2>{task.title}</h2><span className={`task-state ${task.status}`}>{task.status.replace('_',' ')}</span></div>
            <p>{task.next_action||'No next action yet.'}</p>{task.blocked_reason&&<p className="notice">Blocked: {task.blocked_reason}</p>}
            <div className="memory-meta"><span className="fine muted">{task.priority} · revision {task.revision}</span><button className="quiet" disabled={busy} onClick={()=>void open(task)}>Open</button></div></article>)}</div>}
      </>}
    </section>
  </div>;
}
