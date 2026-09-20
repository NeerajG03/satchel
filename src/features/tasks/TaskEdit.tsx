import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useStores } from '../../app/stores';
import { isConflict, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { projectScope, scopeQuery } from '../../app/scope';
import { errorMessage } from '../../client';
import { actorLabel, fullDate } from '../../app/format';
import type { TaskDetail, TaskDraft } from './model';
import { Button, LinkButton } from '../../ui/Button';
import { SelectField, TextArea, TextField } from '../../ui/Field';
import { LoadError, Notice, SaveError, Skeleton } from '../../ui/Notice';
import { PRIORITIES, lines } from './TaskCapture';

type Conflict = { revision: number; by: string; at: string };

export function TaskEdit() {
  const { id = '' } = useParams();
  const stores = useStores();
  const navigate = useNavigate();
  const { announce } = useReadout();
  const page = useLoad(async () => {
    const [task, apps] = await Promise.all([stores.tasks.read(id), stores.connections.list()]);
    return { task, apps };
  }, [stores, id]);
  const [base, setBase] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [doneWhen, setDoneWhen] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [dependencyIds, setDependencyIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);

  useEffect(() => {
    const task = page.data?.task;
    if (!task || base) return;
    setBase(task); setDraft(task); setDoneWhen(task.done_when.join('\n')); setParentId(task.parent_id); setDependencyIds(task.dependency_ids);
  }, [page.data, base]);

  const scope = projectScope(base?.project_id ?? null);
  const back = `/tasks/${id}${scopeQuery(scope)}`;
  useFooter(base ? `Editing · revision ${base.revision} · save writes revision ${base.revision + 1}` : '');

  const changed = base && draft && (draft.title !== base.title || draft.outcome !== base.outcome || draft.why !== base.why || draft.next_action !== base.next_action
    || draft.priority !== base.priority || lines(doneWhen).join('\n') !== base.done_when.join('\n') || parentId !== base.parent_id
    || dependencyIds.slice().sort().join() !== base.dependency_ids.slice().sort().join());

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!base || !draft) return;
    setBusy(true); setError(''); setConflict(null);
    try {
      let current = base;
      const fieldsChanged = draft.title !== base.title || draft.outcome !== base.outcome || draft.why !== base.why || draft.next_action !== base.next_action || draft.priority !== base.priority || lines(doneWhen).join('\n') !== base.done_when.join('\n');
      if (fieldsChanged) current = { ...current, ...(await stores.tasks.update(current, crypto.randomUUID(), { ...draft, done_when: lines(doneWhen) })) };
      if (parentId !== base.parent_id) current = { ...current, ...(await stores.tasks.setParent(current, crypto.randomUUID(), parentId)).task };
      for (const dep of base.dependency_ids.filter(item => !dependencyIds.includes(item))) current = { ...current, ...(await stores.tasks.removeDependency(current, crypto.randomUUID(), dep)).task };
      for (const dep of dependencyIds.filter(item => !base.dependency_ids.includes(item))) current = { ...current, ...(await stores.tasks.addDependency(current, crypto.randomUUID(), dep)).task };
      announce(`Saved · revision ${current.revision}`);
      navigate(back);
    } catch (reason) {
      if (isConflict(reason)) {
        const latest = await stores.tasks.read(id).catch(() => null);
        setConflict({ revision: latest?.revision ?? base.revision + 1, by: latest ? actorLabel(latest.updated_by, page.data?.apps ?? []) : 'someone', at: latest?.updated_at ?? new Date().toISOString() });
        if (latest) setBase(latest);
      } else {
        setError(errorMessage(reason));
        const latest = await stores.tasks.read(id).catch(() => null);
        if (latest) setBase(latest);
      }
    } finally { setBusy(false); }
  }
  function discard() {
    if (!changed || confirm('Discard your changes to this task?')) navigate(back);
  }
  function showLatest() {
    if (!base) return;
    setDraft(base); setDoneWhen(base.done_when.join('\n')); setParentId(base.parent_id); setDependencyIds(base.dependency_ids); setConflict(null);
  }

  if (page.error) return <><LinkButton to="/tasks" look="quiet">← Tasks</LinkButton><LoadError what="This task" onReload={page.reload} /></>;
  if (!base || !draft || !page.data) return <><LinkButton to="/tasks" look="quiet">← Tasks</LinkButton><Skeleton rows={6} /></>;
  const others = base.scope_tasks.filter(task => task.id !== base.id);

  return <>
    <div className="between wrap">
      <Link to={back} className="fine">← Back to task</Link>
      <span className="eyebrow">Editing task · state does not change here</span>
    </div>
    <h1>{base.title}</h1>
    {conflict && <Notice look="error" title="This task changed while you were editing."
      actions={<><Button small onClick={showLatest}>Show revision {conflict.revision}</Button><Button small onClick={() => setConflict(null)}>Keep my text as a new draft</Button><Button small look="quiet" onClick={() => navigate(back)}>Discard mine</Button></>}>
      {conflict.by} saved revision {conflict.revision} at {fullDate(conflict.at)}. Your text was not saved and nothing was overwritten.
    </Notice>}
    <form className="two" onSubmit={save}>
      <div className="stack">
        <TextField label="Title" limit={200} required value={draft.title} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} />
        <TextArea label="Next action" hint="the one concrete thing to do first" limit={1000} rows={2} value={draft.next_action} disabled={busy} onChange={e => setDraft({ ...draft, next_action: e.target.value })} />
        <TextArea label="Outcome" hint="what is true when this is done" limit={1000} rows={2} value={draft.outcome} disabled={busy} onChange={e => setDraft({ ...draft, outcome: e.target.value })} />
        <TextArea label="Why" hint="the reason it matters" limit={4000} rows={3} value={draft.why} disabled={busy} onChange={e => setDraft({ ...draft, why: e.target.value })} />
        <TextArea label="Done when" hint="one per line, each becomes a checkbox" rows={4} value={doneWhen} disabled={busy} onChange={e => setDoneWhen(e.target.value)} />
        <SelectField label="Priority" value={draft.priority} disabled={busy} onChange={e => setDraft({ ...draft, priority: e.target.value as TaskDraft['priority'] })}>
          {PRIORITIES.map(value => <option key={value} value={value}>{value}</option>)}
        </SelectField>
        {error && <SaveError message={error} />}
        <div className="between">
          <Button look="quiet" disabled={busy} onClick={discard}>Discard</Button>
          <Button type="submit" look="primary" disabled={busy || !draft.title.trim() || !changed}>{busy ? 'Saving…' : 'Save task'}</Button>
        </div>
      </div>
      <aside id="planning">
        <div className="aside-block">
          <div className="between"><h3>Planning</h3></div>
          <SelectField label="Parent task" value={parentId ?? ''} disabled={busy} onChange={e => setParentId(e.target.value || null)}>
            <option value="">No parent</option>{others.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
          </SelectField>
          <fieldset className="stack-tight" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="f" style={{ marginBottom: 6 }}>Depends on</legend>
            {others.length === 0 && <span className="fine muted">No other tasks in this scope.</span>}
            {others.map(task => <label className="check" key={task.id}><input type="checkbox" checked={dependencyIds.includes(task.id)} disabled={busy}
              onChange={e => setDependencyIds(e.target.checked ? [...dependencyIds, task.id] : dependencyIds.filter(item => item !== task.id))} /><span>{task.title}</span></label>)}
          </fieldset>
        </div>
        <div className="aside-block">
          <div className="between"><h3>What this write does</h3></div>
          <p className="fine muted">Saves with the current revision. If an agent changed the task since you opened it, you get a conflict, not an overwrite.</p>
          <p className="fine muted">Last change: {actorLabel(base.updated_by, page.data.apps)} · {fullDate(base.updated_at)}</p>
        </div>
      </aside>
    </form>
  </>;
}
