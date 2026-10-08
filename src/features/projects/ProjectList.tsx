import { Link, useLocation, useNavigate } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count, whenText } from '../../app/format';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { Chip } from '../../ui/Chip';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { NewProjectSheet } from './NewProjectSheet';

export function ProjectList() {
  const stores = useStores();
  const navigate = useNavigate();
  const location = useLocation();
  const { announce } = useReadout();
  const creating = location.pathname.endsWith('/new');
  const page = useLoad(async () => {
    const [projects, memories, tasks, connections] = await Promise.all([stores.projects.list(), stores.memories.listAll(), stores.tasks.listAll(), stores.connections.list()]);
    return { projects, memories, tasks, connections };
  }, [stores]);
  const action = useAction();
  const data = page.data;
  const live = data?.projects.filter(p => !p.merged_into) ?? [];
  const merged = data?.projects.filter(p => p.merged_into) ?? [];
  useFooter(data ? `${count(live.length, 'topic')}` : '');

  async function create(id: string, name: string, brief: string, slug: string) {
    const created = await action.run(() => stores.projects.create(id, name, brief, slug));
    if (!created) return;
    announce(`Topic created · ${created.name}`);
    navigate(`/topics/${created.id}`, { replace: true });
  }
  async function unmerge(id: string) {
    const project = data?.projects.find(p => p.id === id);
    if (!project) return;
    const done = await action.run(async () => { await stores.projects.unmerge(project); return true; });
    if (!done) return;
    announce(`Merge undone · ${project.name} is back`);
    page.reload();
  }
  const stats = (projectId: string) => {
    const memories = data?.memories.filter(m => m.project_id === projectId).length ?? 0;
    const tasks = data?.tasks.filter(t => t.project_id === projectId && t.status !== 'done').length ?? 0;
    const apps = data?.connections.filter(c => !c.revoked_at && (c.all_projects || c.task_all_projects || c.project_ids.includes(projectId) || c.agent_task_grants.some(g => g.project_id === projectId))).length ?? 0;
    const latest = [...(data?.memories.filter(m => m.project_id === projectId).map(m => m.updated_at) ?? []), ...(data?.tasks.filter(t => t.project_id === projectId).map(t => t.last_activity_at) ?? [])].sort().at(-1);
    return { memories, tasks, apps, latest };
  };

  return <>
    <div className="head">
      <div className="col"><span className="eyebrow">Topics</span><h1>Topics.</h1>
        <p className="lede">A topic is a subject your memories are about. Satchel makes one when a work fact fits none of these. You can also link a codebase or add tasks to it.</p></div>
      <Button look="primary" onClick={() => navigate('/topics/new')}>+ New topic</Button>
    </div>
    {page.error && <LoadError what="Your topics" onReload={page.reload} />}
    {page.loading && !data && <Skeleton rows={4} />}
    {data && live.length === 0 && <Empty title="No topics yet." action={<Button onClick={() => navigate('/topics/new')}>New topic</Button>}>
      “For me” already holds everything that applies everywhere. Satchel makes a topic when a work fact needs one, or you can make one now.
    </Empty>}
    {data && live.length > 0 && <table className="table">
      <thead><tr><th>Topic</th><th>Memories</th><th>Tasks</th><th>Apps with access</th><th>Last activity</th></tr></thead>
      <tbody>{live.map(project => {
        const s = stats(project.id);
        const empty = s.memories === 0 && s.tasks === 0;
        return <tr key={project.id}>
          <td><Link to={`/topics/${project.id}`} className="serif" style={{ fontSize: 20, color: 'var(--ink)' }}>{project.name}</Link>
            {project.made_by === 'satchel' && <> <Chip>made by Satchel</Chip></>}
            <div className="fine muted">{empty ? 'Nothing saved here yet.' : project.brief || 'No brief yet.'}</div>
            {project.project_repositories.length === 0 ? <div className="fine muted">No repositories linked</div>
              : <div className="fine mono muted">{project.project_repositories.map(link => link.repository).join(' · ')}</div>}</td>
          <td className="num">{s.memories}</td><td className="num">{s.tasks}</td><td className="num">{s.apps}</td>
          <td className="fine muted">{s.latest ? whenText(s.latest) : '—'}</td>
        </tr>;
      })}</tbody>
    </table>}
    {merged.length > 0 && <section className="section">
      <div className="between"><h2>Merged</h2><span className="eyebrow">kept so you can undo</span></div>
      {action.error && !creating && <SaveError message={action.error} />}
      {merged.map(project => {
        const into = data?.projects.find(p => p.id === project.merged_into);
        return <div className="between" key={project.id}>
          <span>{project.name} <span className="muted fine">went into {into?.name ?? 'another topic'}</span></span>
          <Button small disabled={action.busy} onClick={() => void unmerge(project.id)}>Undo merge</Button>
        </div>;
      })}
    </section>}
    {creating && data && <NewProjectSheet projects={data.projects} busy={action.busy} error={action.error} onCancel={() => navigate('/topics')} onCreate={(id, name, brief, slug) => void create(id, name, brief, slug)} />}
  </>;
}
