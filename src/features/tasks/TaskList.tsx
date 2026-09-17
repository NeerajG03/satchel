import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { parseScope, scopeEyebrow, scopeName, scopeProjectIdOf, scopeQuery } from '../../app/scope';
import { count } from '../../app/format';
import type { TaskDraft, TaskSummary } from './model';
import { ScopePicker } from '../../shell/ScopePicker';
import { Segments } from '../../ui/Segments';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { LoadError, Skeleton } from '../../ui/Notice';
import { TaskCapture } from './TaskCapture';
import { TaskRow } from './TaskRow';

type View = 'actionable' | 'moving' | 'blocked' | 'done' | 'all';
const VIEWS: { key: View; label: string; test: (task: TaskSummary) => boolean }[] = [
  { key: 'actionable', label: 'Actionable', test: task => task.actionable && task.status !== 'done' },
  { key: 'moving', label: 'Moving', test: task => task.status === 'ready' || task.status === 'in_progress' },
  { key: 'blocked', label: 'Blocked', test: task => task.status === 'blocked' },
  { key: 'done', label: 'Done', test: task => task.status === 'done' },
  { key: 'all', label: 'All', test: () => true },
];

export function TaskList() {
  const stores = useStores();
  const navigate = useNavigate();
  const { announce } = useReadout();
  const [params, setParams] = useSearchParams();
  const scope = parseScope(params.get('scope'));
  const projectId = scopeProjectIdOf(scope);
  const query = params.get('q') ?? '';
  const viewParam = params.get('view');
  const view = VIEWS.find(item => item.key === viewParam)?.key ?? null;
  const compose = params.get('compose') === '1';

  const projects = useLoad(() => stores.projects.list(), [stores]);
  const tasks = useLoad(() => stores.tasks.list(projectId), [stores, projectId]);
  const action = useAction();
  const [showDone, setShowDone] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  const projectList = projects.data ?? [];
  const all = tasks.data ?? [];
  const counts = Object.fromEntries(VIEWS.map(item => [item.key, all.filter(item.test).length])) as Record<View, number>;
  const current: View = view ?? (counts.actionable > 0 ? 'actionable' : 'all');
  const needle = query.trim().toLowerCase();
  const filtered = all.filter(VIEWS.find(item => item.key === current)!.test)
    .filter(task => !needle || `${task.title} ${task.next_action}`.toLowerCase().includes(needle));
  const hiddenDone = current === 'all' && !showDone ? filtered.filter(task => task.status === 'done').length : 0;
  const visible = hiddenDone ? filtered.filter(task => task.status !== 'done') : filtered;
  const label = scopeName(scope, projectList);

  useFooter(`${count(all.length, 'task')} · ${counts.actionable} actionable · ${label}`);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: key === 'q' });
  }
  async function capture(draft: TaskDraft): Promise<boolean> {
    const created = await action.run(() => stores.tasks.create(projectId, crypto.randomUUID(), crypto.randomUUID(), draft));
    if (!created) return false;
    tasks.reload();
    setComposeOpen(false);
    if (compose) setParam('compose', null);
    announce(`Captured · ${created.status === 'inbox' ? 'in Inbox' : 'ready'}`);
    return true;
  }
  async function exportScope() {
    const files = await action.run(() => stores.tasks.exportProject(projectId));
    if (files !== undefined) announce(`Exported ${label} tasks${files ? ` + ${count(files, 'file')}` : ''}`);
  }

  return <>
    <div className="head">
      <div className="col">
        <span className="eyebrow">{scopeEyebrow(scope, projectList)}</span>
        <h1>Continue.</h1>
        <p className="lede">Tasks hold the exact next action and the evidence a session leaves behind. They don’t need a repository, and they don’t need a project.</p>
      </div>
      <div className="row wrap" style={{ alignItems: 'flex-start' }}>
        <ScopePicker scope={scope} projects={projectList} onChange={next => navigate(`/tasks${scopeQuery(next)}`)} onNewProject={() => navigate('/projects/new')} />
        <Button disabled={action.busy} onClick={() => void exportScope()}>Export</Button>
        <Button look="primary" onClick={() => setComposeOpen(true)}>+ Capture</Button>
      </div>
    </div>

    <TaskCapture scopeLabel={label} open={composeOpen || compose} busy={action.busy} error={action.error}
      onOpen={() => setComposeOpen(true)} onCancel={() => { setComposeOpen(false); action.clear(); if (compose) setParam('compose', null); }} onSave={capture} />

    <div className="between wrap">
      <Segments label="Task state" value={current} onChange={next => setParam('view', next)} items={VIEWS.map(item => ({ key: item.key, label: item.label, count: counts[item.key] }))} />
      <label className="search"><span aria-hidden="true">⌕</span>
        <input type="search" placeholder="Title or next action" aria-label="Search tasks" value={query} onChange={event => setParam('q', event.target.value || null)} />
      </label>
    </div>

    {tasks.error && <LoadError what="Your tasks" onReload={tasks.reload} />}
    {tasks.loading && !tasks.data && <Skeleton rows={4} />}
    {tasks.data && all.length === 0 && <Empty title="Nothing to continue yet.">
      Once a task exists, agents can record progress and handoffs on it. This list then shows what is moving, what is blocked, and the next action for each.
    </Empty>}
    {tasks.data && all.length > 0 && visible.length === 0 && <Empty title="No matching tasks.">Clear a filter to see the rest of this scope.</Empty>}
    <div>{visible.map(task => <TaskRow key={task.id} task={task} projects={projectList} parentTitle={all.find(item => item.id === task.parent_id)?.title} />)}</div>
    {hiddenDone > 0 && <p className="fine muted">{count(hiddenDone, 'done task is', 'done tasks are')} hidden. <Button look="link" onClick={() => setShowDone(true)}>Show done</Button></p>}
  </>;
}
