import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count, whenText } from '../../app/format';
import { scopeQuery } from '../../app/scope';
import type { ProjectRepositoryLink } from './repository';
import { Button, LinkButton } from '../../ui/Button';
import { TextArea } from '../../ui/Field';
import { Light } from '../../ui/Light';
import { LoadError, Notice, SaveError, Skeleton } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';
import { StateChip } from '../../ui/Chip';
import { RepositoryLinks } from './RepositoryLinks';

export function ProjectPage() {
  const { id = '' } = useParams();
  const stores = useStores();
  const { announce } = useReadout();
  const page = useLoad(async () => {
    const [projects, memories, tasks, connections] = await Promise.all([stores.projects.list(), stores.memories.list({ kind: 'project', projectId: id }), stores.tasks.list(id), stores.connections.list()]);
    return { projects, memories, tasks, connections: connections.filter(c => !c.revoked_at) };
  }, [stores, id]);
  const action = useAction();
  const [editingBrief, setEditingBrief] = useState(false);
  const [brief, setBrief] = useState('');

  const data = page.data;
  const project = data?.projects.find(p => p.id === id);
  const scope = { kind: 'project' as const, projectId: id };
  const isEmpty = Boolean(data && data.memories.length === 0 && data.tasks.length === 0);
  const apps = data?.connections.filter(c => c.project_ids.includes(id) || c.agent_task_grants.some(g => g.project_id === id)) ?? [];
  useFooter(project ? `${project.name} · ${count(data!.memories.length, 'memory', 'memories')} · ${count(data!.tasks.length, 'task')}` : '',
    isEmpty ? { light: 'amber', word: 'Project has nothing yet' } : undefined);

  async function saveBrief(event: FormEvent) {
    event.preventDefault(); if (!project) return;
    const updated = await action.run(() => stores.projects.update(project, project.name, brief));
    if (!updated) return;
    page.replace(current => ({ ...current, projects: current.projects.map(p => p.id === updated.id ? updated : p) }));
    setEditingBrief(false); announce('Brief saved');
  }
  async function link(value: string): Promise<boolean> {
    if (!project) return false;
    const added = await action.run(() => stores.projects.linkRepository(project.id, value));
    if (!added) return false;
    page.replace(current => ({ ...current, projects: current.projects.map(p => p.id === project.id ? { ...p, project_repositories: [...p.project_repositories.filter(l => l.repository !== added.repository), added] } : p) }));
    announce(`Linked ${added.repository}`); return true;
  }
  async function unlink(target: ProjectRepositoryLink) {
    if (!project) return;
    const ok = await action.run(async () => { await stores.projects.unlinkRepository(project.id, target); return true; });
    if (!ok) return;
    page.replace(current => ({ ...current, projects: current.projects.map(p => p.id === project.id ? { ...p, project_repositories: p.project_repositories.filter(l => l.repository !== target.repository) } : p) }));
    announce(`Unlinked ${target.repository}`);
  }

  if (page.error) return <><LinkButton to="/projects" look="quiet">← Projects</LinkButton><LoadError what="This project" onReload={page.reload} /></>;
  if (!data) return <><LinkButton to="/projects" look="quiet">← Projects</LinkButton><Skeleton rows={6} /></>;
  if (!project) return <><LinkButton to="/projects" look="quiet">← Projects</LinkButton><Notice look="error" title="That project is not here.">It may have been removed. Nothing else changed.</Notice></>;

  const other = data.projects.find(p => p.id !== id);
  const activity = [...data.tasks.map(t => ({ at: t.last_activity_at, text: t.title, tag: 'task', to: `/tasks/${t.id}${scopeQuery(scope)}` })),
    ...data.memories.map(m => ({ at: m.updated_at, text: m.name, tag: `memory · rev ${m.revision}`, to: `/book${scopeQuery(scope)}` }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);

  const briefForm = <form className="stack-tight" onSubmit={saveBrief}>
    <TextArea label="Brief" hint="one or two lines an agent reads to know what this effort is" limit={1000} rows={3} value={brief} disabled={action.busy} autoFocus
      placeholder="What is this project for, and what does “done” look like?" onChange={e => setBrief(e.target.value)} />
    {action.error && <SaveError message={action.error} />}
    <div className="row" style={{ gap: 8 }}>
      <Button type="submit" look="primary" small disabled={action.busy}>Save brief</Button>
      {!isEmpty && <Button look="quiet" small disabled={action.busy} onClick={() => setEditingBrief(false)}>Cancel</Button>}
      <span className="fine muted">You can change it any time.</span>
    </div>
  </form>;

  return <>
    <div className="between wrap"><Link to="/projects" className="fine">← Projects</Link>
      <div className="row" style={{ gap: 8 }}><LinkButton to={`/book${scopeQuery(scope)}`}>Open its book</LinkButton><LinkButton to={`/tasks${scopeQuery(scope)}`}>Open its tasks</LinkButton></div></div>
    <div className="col" style={{ gap: 10 }}>
      <span className="eyebrow">Project</span>
      <h1>{project.name}</h1>
      {isEmpty ? null : editingBrief ? briefForm : <div className="row wrap" style={{ alignItems: 'baseline' }}>
        <p className="serif" style={{ fontSize: 19, lineHeight: 1.45, maxWidth: 640 }}>{project.brief || <span className="muted">No brief yet.</span>}</p>
        <Button look="link" small onClick={() => { setBrief(project.brief); setEditingBrief(true); }}>Edit brief</Button>
      </div>}
    </div>

    {isEmpty && <>
      <Notice look="amber" title="Agents can’t see this project yet.">It has no brief, no memories and no tasks. Fill in the brief first so an agent can tell it apart{other ? ` from “${other.name}”` : ''}.</Notice>
      {project.brief && !editingBrief ? <div className="row wrap" style={{ alignItems: 'baseline' }}><p className="serif" style={{ fontSize: 19 }}>{project.brief}</p><Button look="link" small onClick={() => { setBrief(project.brief); setEditingBrief(true); }}>Edit brief</Button></div> : briefForm}
      <div className="steps">
        <div className="step"><span className="n">Codebases</span><h3>Link a repository</h3><p className="muted">Optional. Lets a coding agent select this project when it opens that repo.</p></div>
        <div className="step"><span className="n">Book</span><h3>Save a first decision</h3><p className="muted">Something agents should know before working here.</p><LinkButton to={`/book${scopeQuery(scope, { compose: '1' })}`}>Write in this project’s book</LinkButton></div>
        <div className="step"><span className="n">Tasks</span><h3>Capture the next thing</h3><p className="muted">A title and next action is enough to start.</p><LinkButton to={`/tasks${scopeQuery(scope, { compose: '1' })}`}>Capture a task</LinkButton></div>
      </div>
    </>}

    <div className="two">
      <div className="stack" style={{ gap: 28 }}>
        <RepositoryLinks project={project} busy={action.busy} onLink={link} onUnlink={target => void unlink(target)} />
        {!isEmpty && <section className="section">
          <div className="between"><h2>Activity</h2><span className="eyebrow">newest first</span></div>
          {activity.map(item => <div className="relation" key={item.to + item.at}><Link to={item.to}>{item.text}</Link><Provenance parts={[item.tag]} at={item.at} /></div>)}
        </section>}
      </div>
      <aside>
        <div className="aside-block">
          <div className="between"><h3>Apps that can see this project</h3><Link to="/apps" className="fine">Manage</Link></div>
          {apps.length === 0 && <p className="muted fine">None yet. Grants are made on the consent page when an app connects.</p>}
          {apps.map(app => <div className="between" key={app.client_id}><span style={{ fontWeight: 500 }}>{app.label}</span>
            <Light color="green" word={[app.project_ids.includes(id) && (app.can_write ? 'memory rw' : 'memory'), app.agent_task_grants.some(g => g.project_id === id) && 'tasks'].filter(Boolean).join(' · ')} /></div>)}
        </div>
        <div className="aside-block">
          <div className="between"><h3>Tasks <span className="muted fine">· {data.tasks.length}</span></h3><Link to={`/tasks${scopeQuery(scope)}`} className="fine">All tasks</Link></div>
          {data.tasks.slice(0, 4).map(task => <div className="relation" key={task.id}><Link to={`/tasks/${task.id}${scopeQuery(scope)}`}>{task.title}</Link><StateChip status={task.status} /></div>)}
        </div>
        <div className="aside-block">
          <div className="between"><h3>Memories <span className="muted fine">· {data.memories.length}</span></h3><Link to={`/book${scopeQuery(scope)}`} className="fine">Open the book</Link></div>
          {data.memories.slice(0, 4).map(memory => <div className="relation" key={memory.id}><span>{memory.name}</span><span className="fine muted">{whenText(memory.updated_at)}</span></div>)}
        </div>
      </aside>
    </div>
  </>;
}
