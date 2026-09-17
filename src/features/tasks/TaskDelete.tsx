import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useStores } from '../../app/stores';
import { isConflict, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { projectScope, scopeName, scopeQuery } from '../../app/scope';
import { errorMessage } from '../../client';
import { count } from '../../app/format';
import { Button, LinkButton } from '../../ui/Button';
import { LoadError, Notice, Skeleton } from '../../ui/Notice';
import { StateChip } from '../../ui/Chip';

export function TaskDelete() {
  const { id = '' } = useParams();
  const stores = useStores();
  const navigate = useNavigate();
  const { announce } = useReadout();
  const page = useLoad(async () => {
    const [task, projects] = await Promise.all([stores.tasks.read(id), stores.projects.list()]);
    return { task, projects };
  }, [stores, id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  const task = page.data?.task;
  const scope = projectScope(task?.project_id ?? null);
  const label = scopeName(scope, page.data?.projects ?? []);
  const back = `/tasks/${id}${scopeQuery(scope)}`;
  useFooter(task ? `Delete task · ${label} · revision ${task.revision}` : '');

  async function remove() {
    if (!task) return;
    setBusy(true); setError(''); setConflict(false);
    try {
      const result = await stores.tasks.remove(task);
      announce(`Deleted “${result.title}”`);
      navigate(`/tasks${scopeQuery(scope)}`, { replace: true });
    } catch (reason) {
      if (isConflict(reason)) { setConflict(true); page.reload(); }
      else setError(errorMessage(reason));
    } finally { setBusy(false); }
  }

  if (page.error) return <><LinkButton to="/tasks" look="quiet">← Tasks</LinkButton><LoadError what="This task" onReload={page.reload} /></>;
  if (!task) return <><LinkButton to="/tasks" look="quiet">← Tasks</LinkButton><Skeleton rows={4} /></>;

  const children = task.scope_tasks.filter(item => item.parent_id === task.id);
  const dependents = task.scope_tasks.filter(item => item.dependency_ids.includes(task.id));
  const files = task.resources.filter(resource => resource.kind === 'storage_object' && resource.upload_status === 'verified').length;
  const entries = task.updates.length + task.handoffs.length;

  return <>
    <div className="between wrap">
      <Link to={back} className="fine">← Back to task</Link>
      <span className="eyebrow">Delete task · this cannot be undone</span>
    </div>
    <div className="col" style={{ gap: 10 }}>
      <span className="eyebrow">{label}</span>
      <h1>Delete “{task.title}”?</h1>
      <div className="row wrap" style={{ alignItems: 'center', gap: 8 }}><StateChip status={task.status} /><span className="fine muted">revision {task.revision}</span></div>
    </div>

    {conflict && <Notice look="error" title="This task changed while you were looking.">Someone saved a newer revision. The page reloaded it. Read it again before you delete.</Notice>}

    <div className="two">
      <div className="stack">
        <Notice look="amber" title="What goes away">
          <ul className="plain-list">
            <li>The task itself and its next action.</li>
            <li>{entries === 0 ? 'No timeline entries yet.' : `${count(entries, 'timeline entry', 'timeline entries')}: comments, progress and handoffs.`}</li>
            <li>{task.resources.length === 0 ? 'No attached links or files.' : `${count(task.resources.length, 'attached resource')}${files ? `, including ${count(files, 'uploaded file')} removed from storage` : ''}.`}</li>
            <li>Its technical history of {count(task.events.length, 'event')}.</li>
          </ul>
        </Notice>
        {(children.length > 0 || dependents.length > 0) && <Notice title="Other tasks stay, but lose a link">
          <ul className="plain-list">
            {children.length > 0 && <li>{count(children.length, 'child task')} will have no parent: {children.map(item => item.title).join(', ')}.</li>}
            {dependents.length > 0 && <li>{count(dependents.length, 'task')} stop waiting on this one: {dependents.map(item => item.title).join(', ')}.</li>}
          </ul>
        </Notice>}
        <p className="muted">Agents that already read this task keep whatever they copied into their own notes. Satchel can’t reach those. Exports you downloaded are not touched either.</p>
        {error && <Notice look="error" title="Could not delete.">{error}</Notice>}
        <div className="between">
          <LinkButton to={back} look="quiet">Keep the task</LinkButton>
          <Button look="danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete this task'}</Button>
        </div>
      </div>
      <aside>
        <div className="aside-block">
          <div className="between"><h3>Not sure?</h3></div>
          <p className="fine muted">Moving a task to Done keeps its history and hides it from the main list. <Link to={back}>Go back</Link> and use “Move to” instead if you only want it out of the way.</p>
        </div>
      </aside>
    </div>
  </>;
}
