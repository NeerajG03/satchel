import { Link, useLocation, useNavigate } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count, whenText } from '../../app/format';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { LoadError, Skeleton } from '../../ui/Notice';
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
  useFooter(data ? `${count(data.projects.length, 'project')}` : '');

  async function create(id: string, name: string, brief: string, slug: string) {
    const created = await action.run(() => stores.projects.create(id, name, brief, slug));
    if (!created) return;
    announce(`Project created · ${created.name}`);
    navigate(`/projects/${created.id}`, { replace: true });
  }
  const stats = (projectId: string) => {
    const memories = data?.memories.filter(m => m.project_id === projectId).length ?? 0;
    const tasks = data?.tasks.filter(t => t.project_id === projectId && t.status !== 'done').length ?? 0;
    const apps = data?.connections.filter(c => !c.revoked_at && (c.project_ids.includes(projectId) || c.agent_task_grants.some(g => g.project_id === projectId))).length ?? 0;
    const latest = [...(data?.memories.filter(m => m.project_id === projectId).map(m => m.updated_at) ?? []), ...(data?.tasks.filter(t => t.project_id === projectId).map(t => t.last_activity_at) ?? [])].sort().at(-1);
    return { memories, tasks, apps, latest };
  };

  return <>
    <div className="head">
      <div className="col"><span className="eyebrow">Projects</span><h1>Projects.</h1>
        <p className="lede">A project is an ongoing effort, not a repository. Link as many codebases as it needs, or none at all.</p></div>
      <Button look="primary" onClick={() => navigate('/projects/new')}>+ New project</Button>
    </div>
    {page.error && <LoadError what="Your projects" onReload={page.reload} />}
    {page.loading && !data && <Skeleton rows={4} />}
    {data && data.projects.length === 0 && <Empty title="No projects yet." action={<Button onClick={() => navigate('/projects/new')}>New project</Button>}>
      “For me” already holds everything that applies everywhere. Make a project when some memories or tasks belong to one effort only.
    </Empty>}
    {data && data.projects.length > 0 && <table className="table">
      <thead><tr><th>Project</th><th>Memories</th><th>Tasks</th><th>Apps with access</th><th>Last activity</th></tr></thead>
      <tbody>{data.projects.map(project => {
        const s = stats(project.id);
        const empty = s.memories === 0 && s.tasks === 0;
        return <tr key={project.id}>
          <td><Link to={`/projects/${project.id}`} className="serif" style={{ fontSize: 20, color: 'var(--ink)' }}>{project.name}</Link>
            <div className="fine muted">{empty ? 'Nothing saved here yet.' : project.brief || 'No brief yet.'}</div>
            {project.project_repositories.length === 0 ? <div className="fine muted">No repositories linked</div>
              : <div className="fine mono muted">{project.project_repositories.map(link => link.repository).join(' · ')}</div>}</td>
          <td className="num">{s.memories}</td><td className="num">{s.tasks}</td><td className="num">{s.apps}</td>
          <td className="fine muted">{s.latest ? whenText(s.latest) : '—'}</td>
        </tr>;
      })}</tbody>
    </table>}
    {creating && data && <NewProjectSheet projects={data.projects} busy={action.busy} error={action.error} onCancel={() => navigate('/projects')} onCreate={(id, name, brief, slug) => void create(id, name, brief, slug)} />}
  </>;
}
