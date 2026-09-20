import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useStores } from '../../app/stores';
import { isConflict, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { errorMessage } from '../../client';
import { count } from '../../app/format';
import { Button, LinkButton } from '../../ui/Button';
import { TextField } from '../../ui/Field';
import { LoadError, Notice, Skeleton } from '../../ui/Notice';

export function ProjectDelete() {
  const { id = '' } = useParams();
  const stores = useStores();
  const navigate = useNavigate();
  const { announce } = useReadout();
  const page = useLoad(async () => {
    const [projects, memories, tasks, connections] = await Promise.all([stores.projects.list(), stores.memories.list({ kind: 'project', projectId: id }), stores.tasks.list(id), stores.connections.list()]);
    return { projects, memories, tasks, connections: connections.filter(c => !c.revoked_at) };
  }, [stores, id]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  const data = page.data;
  const project = data?.projects.find(p => p.id === id);
  const back = `/projects/${id}`;
  useFooter(project ? `Delete project · ${project.name}` : '');

  async function remove() {
    if (!project) return;
    setBusy(true); setError(''); setConflict(false);
    try {
      const result = await stores.projects.remove(project);
      announce(`Deleted “${result.name}” · ${count(result.memories_removed, 'memory', 'memories')} · ${count(result.tasks_removed, 'task')}`);
      navigate('/projects', { replace: true });
    } catch (reason) {
      if (isConflict(reason)) { setConflict(true); page.reload(); }
      else setError(errorMessage(reason));
    } finally { setBusy(false); }
  }

  if (page.error) return <><LinkButton to="/projects" look="quiet">← Projects</LinkButton><LoadError what="This project" onReload={page.reload} /></>;
  if (!data) return <><LinkButton to="/projects" look="quiet">← Projects</LinkButton><Skeleton rows={4} /></>;
  if (!project) return <><LinkButton to="/projects" look="quiet">← Projects</LinkButton><Notice look="error" title="That project is not here.">It may already be gone. Nothing else changed.</Notice></>;

  const apps = data.connections.filter(c => c.project_ids.includes(id) || c.agent_task_grants.some(g => g.project_id === id));
  const ready = typed.trim() === project.name;

  return <>
    <div className="between wrap">
      <Link to={back} className="fine">← Back to project</Link>
      <span className="eyebrow">Delete project · this cannot be undone</span>
    </div>
    <div className="col" style={{ gap: 10 }}>
      <span className="eyebrow">Project</span>
      <h1>Delete “{project.name}”?</h1>
      {project.brief && <p className="serif muted" style={{ fontSize: 17 }}>{project.brief}</p>}
    </div>

    {conflict && <Notice look="error" title="This project changed while you were looking.">Someone saved a newer revision. The page reloaded it. Read it again before you delete.</Notice>}

    <div className="two">
      <div className="stack">
        <Notice look="amber" title="Everything in it goes too">
          <ul className="plain-list">
            <li>{data.memories.length === 0 ? 'No memories in its book.' : `${count(data.memories.length, 'memory', 'memories')} in its book.`}</li>
            <li>{data.tasks.length === 0 ? 'No tasks.' : `${count(data.tasks.length, 'task')}, with every comment, handoff and uploaded file.`}</li>
            <li>{project.project_repositories.length === 0 ? 'No linked repositories.' : `${count(project.project_repositories.length, 'linked repository', 'linked repositories')}. Agents opening those repos will no longer land here.`}</li>
            <li>{apps.length === 0 ? 'No app can see this project.' : `${count(apps.length, 'connected app')} lose access to it: ${apps.map(a => a.label).join(', ')}. Their other grants stay.`}</li>
          </ul>
        </Notice>
        <p className="muted">Your “For me” memories and personal tasks are separate and stay put. Agents keep whatever they already copied into their own notes. Satchel can’t reach those.</p>
        <TextField label="Type the project name to confirm" hint={project.name} value={typed} disabled={busy} autoComplete="off" onChange={e => setTyped(e.target.value)} />
        {error && <Notice look="error" title="Could not delete.">{error}</Notice>}
        <div className="between">
          <LinkButton to={back} look="quiet">Keep the project</LinkButton>
          <Button look="danger" disabled={busy || !ready} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete this project'}</Button>
        </div>
      </div>
      <aside>
        <div className="aside-block">
          <div className="between"><h3>Want a copy first?</h3></div>
          <p className="fine muted">Export its tasks from <Link to={`/tasks?scope=${id}`}>the task list</Link> before you delete. Memories can be read from <Link to={`/book?scope=${id}`}>its book</Link>.</p>
        </div>
      </aside>
    </div>
  </>;
}
