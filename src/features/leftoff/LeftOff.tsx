import { Link } from 'react-router';
import { useStores } from '../../app/stores';
import { useLoad } from '../../app/useLoad';
import { useFooter } from '../../app/readout';
import { useAuth } from '../../app/auth';
import { count } from '../../app/format';
import { projectScope, scopeName, scopeQuery } from '../../app/scope';
import { LinkButton } from '../../ui/Button';
import { StateChip } from '../../ui/Chip';
import { Light } from '../../ui/Light';
import { LoadError, Skeleton } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';
import { accountHandle } from '../../shell/Header';
import { LeftOffEmpty } from './LeftOffEmpty';
import { TaskRow } from '../tasks/TaskRow';

export function LeftOff() {
  const stores = useStores();
  const { user } = useAuth();
  const page = useLoad(async () => {
    const [projects, tasks, memories, connections] = await Promise.all([
      stores.projects.list(), stores.tasks.listAll(), stores.memories.listAll(), stores.connections.list(),
    ]);
    return { projects, tasks, memories, connections };
  }, [stores]);

  const data = page.data;
  const firstRun = data && data.tasks.length === 0 && data.memories.length === 0 && data.connections.filter(c => !c.revoked_at).length === 0;
  const actionable = data?.tasks.filter(task => task.actionable && task.status !== 'done') ?? [];
  const blocked = data?.tasks.filter(task => task.status === 'blocked') ?? [];
  const waiting = data ? data.tasks.filter(task => !task.actionable && task.status !== 'done' && task.status !== 'blocked').length : 0;
  const moving = data?.tasks.filter(task => task.status === 'ready' || task.status === 'in_progress').length ?? 0;
  const newest = data?.memories[0];
  const live = data?.connections.filter(c => !c.revoked_at) ?? [];

  useFooter(data ? `${count(data.memories.length, 'in the book', 'in the book')} · ${count(moving, 'task', 'tasks')} moving · ${count(live.length, 'app')}` : '',
    firstRun ? { light: 'amber', word: 'Nothing saved yet' } : undefined);

  if (page.error) return <><h1>Where you left off.</h1><LoadError what="Your tasks and book" onReload={page.reload} /><Skeleton rows={4} /></>;
  if (!data) return <><h1>Where you left off.</h1><Skeleton rows={5} /></>;
  if (firstRun) return <LeftOffEmpty name={accountHandle(user)} projects={data.projects} />;

  return <>
    <div className="head">
      <div className="col"><span className="eyebrow">Left off</span><h1>Where you left off.</h1></div>
      <div className="row"><LinkButton to="/tasks">All tasks</LinkButton><LinkButton to="/book?compose=1" look="primary">Write something down</LinkButton></div>
    </div>
    <div className="two">
      <section className="section">
        <div className="between"><h2>Next actions</h2><span className="eyebrow">{count(actionable.length, 'actionable now', 'actionable now')}</span></div>
        {actionable.length + blocked.length === 0 && <p className="muted">Nothing is actionable right now. {waiting > 0 ? `${count(waiting, 'task is', 'tasks are')} waiting on something.` : 'Capture a task with a next action and it shows up here.'}</p>}
        <div>{actionable.map(task => <TaskRow key={task.id} task={task} projects={data.projects} showScope />)}</div>
        {blocked.length > 0 && <>
          <div className="between" style={{ marginTop: 12 }}><h3>Blocked</h3><span className="eyebrow">{count(blocked.length, 'waiting on something', 'waiting on something')}</span></div>
          <div>{blocked.map(task => <TaskRow key={task.id} task={task} projects={data.projects} showScope />)}</div>
        </>}
        {waiting > 0 && <p className="fine muted">{count(waiting, 'more task is', 'more tasks are')} waiting on something. <Link to="/tasks">See them in Tasks</Link></p>}
      </section>
      <aside>
        <div className="aside-block">
          <div className="between"><h3>Last thing saved</h3></div>
          {newest ? <>
            <p className="serif" style={{ fontSize: 19, lineHeight: 1.4 }}>“{newest.description}”</p>
            <Provenance parts={[newest.name, scopeName(projectScope(newest.project_id), data.projects), `revision ${newest.revision}`]} at={newest.updated_at} />
            <Link to={`/book${scopeQuery(projectScope(newest.project_id))}`} className="fine">Open the book</Link>
          </> : <p className="muted fine">Nothing in the book yet. <Link to="/book">Write the first thing down</Link>.</p>}
        </div>
        <div className="aside-block">
          <div className="between"><h3>Your apps</h3><Link to="/apps" className="fine">Manage apps</Link></div>
          {live.length === 0 && <p className="muted fine">No apps connected. <Link to="/apps">See the steps</Link>.</p>}
          {live.map(app => <div className="between" key={app.client_id}>
            <span style={{ fontWeight: 500 }}>{app.label}</span>
            <Light color="green" word={app.can_write || app.task_can_write ? 'reads and saves' : 'reads only'} />
          </div>)}
        </div>
      </aside>
    </div>
  </>;
}
