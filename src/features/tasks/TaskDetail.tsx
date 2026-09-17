import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { projectScope, scopeName, scopeQuery } from '../../app/scope';
import { actorLabel, count, fullDate, stateWord } from '../../app/format';
import type { TaskDetail as Detail, TaskStatus, TaskSummary } from './model';
import { Button, LinkButton } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { LoadError, Notice, Skeleton } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';
import { StateChip } from '../../ui/Chip';
import { TextField } from '../../ui/Field';
import { Timeline, timelineItems } from './Timeline';
import { UpdateComposer, type UpdateInput } from './UpdateComposer';
import { BlockedSheet } from './BlockedSheet';

const STATES: TaskStatus[] = ['inbox', 'ready', 'in_progress', 'blocked', 'done'];

function handoffText(task: Detail): string {
  const latest = [...task.handoffs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const block = (label: string, items: string[]) => items.length ? `${label}:\n${items.map(item => `- ${item}`).join('\n')}\n` : '';
  const head = `${task.title}\nNext action: ${task.next_action || '(none)'}\nState: ${stateWord(task.status)} · revision ${task.revision}\n`;
  if (!latest) return head + (task.outcome ? `Outcome: ${task.outcome}\n` : '');
  return head + `\nLast handoff (${fullDate(latest.created_at)})\n${latest.summary ? latest.summary + '\n' : ''}` +
    block('Completed', latest.completed) + block('Validated', latest.validation.map(v => String(v.note ?? JSON.stringify(v)))) +
    block('Decisions', latest.decisions) + block('Remaining', latest.remaining) + block('Blockers', latest.blockers);
}

function Related({ title, tasks, scope }: { title: string; tasks: TaskSummary[]; scope: ReturnType<typeof projectScope> }) {
  if (tasks.length === 0) return null;
  return <div className="stack-tight">
    <span className="eyebrow">{title}</span>
    {tasks.map(task => <div className="relation" key={task.id}><Link to={`/tasks/${task.id}${scopeQuery(scope)}`}>{task.title}</Link><StateChip status={task.status} /></div>)}
  </div>;
}

export function TaskDetail() {
  const { id = '' } = useParams();
  const stores = useStores();
  const navigate = useNavigate();
  const { announce } = useReadout();
  const page = useLoad(async () => {
    const [task, projects, apps] = await Promise.all([stores.tasks.read(id), stores.projects.list(), stores.connections.list()]);
    return { task, projects, apps };
  }, [stores, id]);
  const action = useAction();
  const move = useAction();
  const [blocking, setBlocking] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const task = page.data?.task;
  const scope = projectScope(task?.project_id ?? null);
  const label = scopeName(scope, page.data?.projects ?? []);
  useFooter(task ? `Task · ${label} · revision ${task.revision}` : '');

  async function refresh(message?: string) {
    const fresh = await stores.tasks.read(id);
    page.replace(current => ({ ...current, task: fresh }));
    if (message) announce(message);
  }
  async function submitUpdate(input: UpdateInput): Promise<boolean> {
    if (!task) return false;
    const requestId = crypto.randomUUID(); const recordId = crypto.randomUUID();
    const result = await action.run(async () => {
      if (input.mode === 'comment') await stores.tasks.comment(task, requestId, recordId, input.body, input.resourceIds);
      else if (input.mode === 'progress') await stores.tasks.progress(task, requestId, recordId, { summary: input.body, completed: input.completed, decisions: input.decisions,
        remaining: input.remaining, blockers: input.blockers, nextAction: input.nextAction, status: null, blockedReason: '', resourceIds: input.resourceIds });
      else await stores.tasks.handoff(task, requestId, recordId, { summary: input.body, completed: input.completed, decisions: input.decisions,
        validation: input.validation.map(note => ({ note })), remaining: input.remaining, blockers: input.blockers, nextAction: input.nextAction,
        status: null, blockedReason: '', resourceIds: input.resourceIds, supersedesIds: [] });
      await refresh(input.mode === 'comment' ? 'Comment added' : input.mode === 'progress' ? 'Progress recorded' : 'Handoff recorded');
      return true;
    });
    return Boolean(result);
  }
  async function moveTo(status: TaskStatus) {
    if (!task) return;
    if (status === 'blocked') { setBlocking(true); return; }
    await move.run(async () => { await stores.tasks.transition(task, crypto.randomUUID(), status); await refresh(`Moved to ${stateWord(status)}`); });
  }
  async function block(reason: string) {
    if (!task) return;
    const ok = await move.run(async () => {
      await stores.tasks.progress(task, crypto.randomUUID(), crypto.randomUUID(), { summary: reason, completed: [], decisions: [], remaining: [],
        blockers: [reason], nextAction: task.next_action, status: 'blocked', blockedReason: reason, resourceIds: [] });
      await refresh('Moved to blocked'); return true;
    });
    if (ok) setBlocking(false);
  }
  async function copyHandoff() {
    if (!task) return;
    try { await navigator.clipboard.writeText(handoffText(task)); announce('Handoff copied'); }
    catch { announce('Copy failed · select the text instead'); }
  }
  async function attachLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!task) return;
    const form = new FormData(event.currentTarget);
    const ok = await action.run(async () => {
      await stores.tasks.addLink(task, crypto.randomUUID(), crypto.randomUUID(), String(form.get('label')), String(form.get('url')));
      await refresh('Link attached'); return true;
    });
    if (ok) setLinkOpen(false);
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!task) return;
    const form = new FormData(event.currentTarget); const file = form.get('file');
    if (!(file instanceof File) || !file.size) return;
    const ok = await action.run(async () => { await stores.tasks.upload(task, crypto.randomUUID(), crypto.randomUUID(), String(form.get('label') ?? ''), file); await refresh('File uploaded and verified'); return true; });
    if (ok) setLinkOpen(false);
  }

  if (page.error) return <><LinkButton to="/tasks" look="quiet">← Tasks</LinkButton><LoadError what="This task" onReload={page.reload} /></>;
  if (!task || !page.data) return <><LinkButton to="/tasks" look="quiet">← Tasks</LinkButton><Skeleton rows={6} /></>;

  const { projects, apps } = page.data;
  const parent = task.scope_tasks.find(item => item.id === task.parent_id);
  const children = task.scope_tasks.filter(item => item.parent_id === task.id);
  const dependencies = task.scope_tasks.filter(item => task.dependency_ids.includes(item.id));
  const dependents = task.scope_tasks.filter(item => item.dependency_ids.includes(task.id));
  const last = timelineItems(task)[0];
  const stateIndex = STATES.indexOf(task.status);

  return <>
    <div className="between wrap">
      <Link to={`/tasks${scopeQuery(scope)}`} className="fine">← Tasks · {label}</Link>
      <div className="row" style={{ gap: 8 }}>
        <LinkButton to={`/tasks/${task.id}/edit${scopeQuery(scope)}`}>Edit</LinkButton>
        <LinkButton to={`/tasks/${task.id}/delete${scopeQuery(scope)}`} look="quiet">Delete</LinkButton>
        <Menu label="Move to" disabled={move.busy}>{close => STATES.filter(state => state !== task.status).map(state =>
          <button key={state} type="button" role="menuitem" className="option" onClick={() => { close(); void moveTo(state); }}><span>{stateWord(state)}</span>{state === 'blocked' && <span className="fine muted">needs a reason</span>}</button>)}
        </Menu>
      </div>
    </div>
    <div className="col" style={{ gap: 12 }}>
      <ol className="stepper" aria-label="State">{STATES.map((state, index) => <li key={state} aria-current={state === task.status ? 'step' : undefined} className={index < stateIndex ? 'past' : ''}>{stateWord(state)}</li>)}</ol>
      <h1>{task.title}</h1>
      <Provenance parts={[task.priority, `revision ${task.revision}`, `last change by ${actorLabel(task.updated_by, apps)}`]} at={task.last_activity_at} />
    </div>
    {move.error && <Notice look="error" title="Could not move the task.">{move.error}</Notice>}

    <div className="two">
      <div className="stack">
        <div className="panel ink next-panel">
          <div className="between"><span className="eyebrow" style={{ color: '#a79e90' }}>Next action</span><Button small onClick={() => void copyHandoff()}>Copy handoff</Button></div>
          <p className="text">{task.next_action || <span className="muted">No next action yet. Edit the task to add one.</span>}</p>
          {task.status === 'blocked' && task.blocked_reason && <p className="fine" style={{ color: '#f1c25a' }}>Blocked: {task.blocked_reason}</p>}
        </div>
        <UpdateComposer key={task.revision} task={task} busy={action.busy} error={action.error} onSubmit={submitUpdate} />
        <section className="section">
          <div className="between"><h2>Timeline</h2><span className="eyebrow">newest first{last && ` · ${count(task.updates.length + task.handoffs.length, 'entry', 'entries')}`}</span></div>
          <Timeline task={task} apps={apps} />
        </section>
      </div>
      <aside>
        {task.outcome && <div className="aside-block"><div className="between"><h3>Outcome</h3></div><p>{task.outcome}</p></div>}
        {task.why && <div className="aside-block"><div className="between"><h3>Why</h3></div><p className="muted">{task.why}</p></div>}
        {task.done_when.length > 0 && <div className="aside-block"><div className="between"><h3>Done when</h3></div><ul className="done-when">{task.done_when.map(item => <li key={item}>{item}</li>)}</ul></div>}
        <div className="aside-block">
          <div className="between"><h3>Planning</h3><Link to={`/tasks/${task.id}/edit${scopeQuery(scope)}#planning`} className="fine">Change</Link></div>
          <p style={{ fontWeight: 500 }}>{task.actionable ? 'Actionable now' : 'Not actionable'} <span className="muted fine">· {task.blocked_by_ids.length > 0 ? `waiting on ${count(task.blocked_by_ids.length, 'task')}` : 'no unfinished dependencies'}</span></p>
          {parent && <Related title="Parent" tasks={[parent]} scope={scope} />}
          <Related title="Children" tasks={children} scope={scope} />
          <Related title="Depends on" tasks={dependencies} scope={scope} />
          <Related title="Blocks" tasks={dependents} scope={scope} />
        </div>
        <div className="aside-block">
          <div className="between"><h3>Resources</h3><Button look="link" small onClick={() => setLinkOpen(value => !value)}>{linkOpen ? 'Close' : 'Attach'}</Button></div>
          {task.resources.length === 0 && !linkOpen && <p className="muted fine">Nothing attached.</p>}
          {task.resources.map(resource => <div className="relation" key={resource.id}>
            <span>{resource.label} <span className="fine muted">· {resource.kind === 'external_url' ? 'link' : resource.upload_status}</span></span>
            {resource.kind === 'external_url' ? <a href={resource.external_url ?? '#'} target="_blank" rel="noreferrer" className="fine">Open ↗</a>
              : resource.upload_status === 'verified' && <Button look="link" small onClick={() => void action.run(() => stores.tasks.download(resource))}>Download</Button>}
          </div>)}
          {linkOpen && <div className="stack">
            <form className="stack-tight" onSubmit={attachLink}>
              <TextField label="Link label" name="label" required limit={200} disabled={action.busy} />
              <TextField label="HTTPS URL" name="url" type="url" required pattern="https://.*" disabled={action.busy} />
              <Button type="submit" small disabled={action.busy}>Attach link</Button>
            </form>
            <form className="stack-tight" onSubmit={upload}>
              <TextField label="File label" name="label" limit={200} disabled={action.busy} />
              <label className="f">File <span className="hint">max 6 MB</span><input className="field" name="file" type="file" required disabled={action.busy} /></label>
              <Button type="submit" small disabled={action.busy}>Upload file</Button>
            </form>
          </div>}
        </div>
        <details className="history">
          <summary>Technical history · {count(task.events.length, 'event')}</summary>
          {[...task.events].reverse().map(event => <div className="event" key={event.id}><span>{event.event_type.replaceAll('_', ' ')}</span><span className="fine muted">rev {event.to_revision} · {fullDate(event.created_at)}</span></div>)}
        </details>
      </aside>
    </div>
    {blocking && <BlockedSheet task={task} busy={move.busy} error={move.error} onCancel={() => { setBlocking(false); move.clear(); }} onConfirm={reason => void block(reason)} />}
  </>;
}
