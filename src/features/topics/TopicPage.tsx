import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count, whenText } from '../../app/format';
import { scopeQuery } from '../../app/scope';
import type { TopicRepositoryLink } from './repository';
import { Button, LinkButton } from '../../ui/Button';
import { TornPageIcon } from '../../ui/TornPageIcon';
import { TextArea } from '../../ui/Field';
import { Light } from '../../ui/Light';
import { LoadError, Notice, SaveError, Skeleton } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';
import { Chip, StateChip } from '../../ui/Chip';
import { RepositoryLinks } from './RepositoryLinks';

export function TopicPage() {
  const { id = '' } = useParams();
  const stores = useStores();
  const { announce } = useReadout();
  const page = useLoad(async () => {
    const [topics, memories, tasks, connections] = await Promise.all([stores.topics.list(), stores.memories.list({ kind: 'topic', topicId: id }), stores.tasks.list(id), stores.connections.list()]);
    return { topics, memories, tasks, connections: connections.filter(c => !c.revoked_at) };
  }, [stores, id]);
  const action = useAction();
  const [editingBrief, setEditingBrief] = useState(false);
  const [brief, setBrief] = useState('');

  const data = page.data;
  const topic = data?.topics.find(p => p.id === id);
  const scope = { kind: 'topic' as const, topicId: id };
  const isEmpty = Boolean(data && data.memories.length === 0 && data.tasks.length === 0);
  const apps = data?.connections.filter(c => c.all_topics || c.task_all_topics || c.topic_ids.includes(id) || c.agent_task_grants.some(g => g.topic_id === id)) ?? [];
  useFooter(topic ? `${topic.name} · ${count(data!.memories.length, 'memory', 'memories')} · ${count(data!.tasks.length, 'task')}` : '',
    isEmpty ? { light: 'amber', word: 'Topic has nothing yet' } : undefined);

  async function saveBrief(event: FormEvent) {
    event.preventDefault(); if (!topic) return;
    const updated = await action.run(() => stores.topics.update(topic, topic.name, brief));
    if (!updated) return;
    page.replace(current => ({ ...current, topics: current.topics.map(p => p.id === updated.id ? updated : p) }));
    setEditingBrief(false); announce('Brief saved');
  }
  async function link(value: string): Promise<boolean> {
    if (!topic) return false;
    const added = await action.run(() => stores.topics.linkRepository(topic.id, value));
    if (!added) return false;
    page.replace(current => ({ ...current, topics: current.topics.map(p => p.id === topic.id ? { ...p, topic_repositories: [...p.topic_repositories.filter(l => l.repository !== added.repository), added] } : p) }));
    announce(`Linked ${added.repository}`); return true;
  }
  async function unlink(target: TopicRepositoryLink) {
    if (!topic) return;
    const ok = await action.run(async () => { await stores.topics.unlinkRepository(topic.id, target); return true; });
    if (!ok) return;
    page.replace(current => ({ ...current, topics: current.topics.map(p => p.id === topic.id ? { ...p, topic_repositories: p.topic_repositories.filter(l => l.repository !== target.repository) } : p) }));
    announce(`Unlinked ${target.repository}`);
  }

  if (page.error) return <><LinkButton to="/topics" look="quiet">← Topics</LinkButton><LoadError what="This topic" onReload={page.reload} /></>;
  if (!data) return <><LinkButton to="/topics" look="quiet">← Topics</LinkButton><Skeleton rows={6} /></>;
  if (!topic) return <><LinkButton to="/topics" look="quiet">← Topics</LinkButton><Notice look="error" title="That topic is not here.">It may have been removed. Nothing else changed.</Notice></>;

  const other = data.topics.find(p => p.id !== id);
  const activity = [...data.tasks.map(t => ({ at: t.last_activity_at, text: t.title, tag: 'task', to: `/tasks/${t.id}${scopeQuery(scope)}` })),
    ...data.memories.map(m => ({ at: m.updated_at, text: m.name, tag: `memory · rev ${m.revision}`, to: `/book${scopeQuery(scope)}` }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);

  const briefForm = <form className="stack-tight" onSubmit={saveBrief}>
    <TextArea label="Brief" hint="one or two lines an agent reads to know what this effort is" limit={1000} rows={3} value={brief} disabled={action.busy} autoFocus
      placeholder="What is this topic for, and what does “done” look like?" onChange={e => setBrief(e.target.value)} />
    {action.error && <SaveError message={action.error} />}
    <div className="row" style={{ gap: 8 }}>
      <Button type="submit" look="primary" small disabled={action.busy}>Save brief</Button>
      {!isEmpty && <Button look="quiet" small disabled={action.busy} onClick={() => setEditingBrief(false)}>Cancel</Button>}
      <span className="fine muted">You can change it any time.</span>
    </div>
  </form>;

  return <>
    <div className="between wrap"><Link to="/topics" className="fine">← Topics</Link>
      <div className="row" style={{ gap: 8 }}><LinkButton to={`/topics/${id}/delete`} look="quiet" className="tear" aria-label="Delete topic" title="Delete topic"><TornPageIcon /></LinkButton><LinkButton to={`/book${scopeQuery(scope)}`}>Open its book</LinkButton><LinkButton to={`/tasks${scopeQuery(scope)}`}>Open its tasks</LinkButton></div></div>
    <div className="col" style={{ gap: 10 }}>
      <span className="eyebrow">Topic{topic.made_by === 'satchel' ? ' · made by Satchel' : ''}</span>
      <h1>{topic.name}</h1>
      {topic.merged_into && <Notice look="amber" title={`Merged into ${data.topics.find(p => p.id === topic.merged_into)?.name ?? 'another topic'}.`}>
        Its memories moved there. Undo it from the topics list to put them back.</Notice>}
      {isEmpty ? null : editingBrief ? briefForm : <div className="row wrap" style={{ alignItems: 'baseline' }}>
        <p className="serif" style={{ fontSize: 19, lineHeight: 1.45, maxWidth: 640 }}>{topic.brief || <span className="muted">No brief yet.</span>}</p>
        <Button look="link" small onClick={() => { setBrief(topic.brief); setEditingBrief(true); }}>Edit brief</Button>
      </div>}
    </div>

    {isEmpty && <>
      <Notice look="amber" title="Agents can’t see this topic yet.">It has no brief, no memories and no tasks. Fill in the brief first so an agent can tell it apart{other ? ` from “${other.name}”` : ''}.</Notice>
      {topic.brief && !editingBrief ? <div className="row wrap" style={{ alignItems: 'baseline' }}><p className="serif" style={{ fontSize: 19 }}>{topic.brief}</p><Button look="link" small onClick={() => { setBrief(topic.brief); setEditingBrief(true); }}>Edit brief</Button></div> : briefForm}
      <div className="steps">
        <div className="step"><span className="n">Codebases</span><h3>Link a repository</h3><p className="muted">Optional. Lets a coding agent select this topic when it opens that repo.</p></div>
        <div className="step"><span className="n">Book</span><h3>Save a first decision</h3><p className="muted">Something agents should know before working here.</p><LinkButton to={`/book${scopeQuery(scope, { compose: '1' })}`}>Write in this topic’s book</LinkButton></div>
        <div className="step"><span className="n">Tasks</span><h3>Capture the next thing</h3><p className="muted">A title and next action is enough to start.</p><LinkButton to={`/tasks${scopeQuery(scope, { compose: '1' })}`}>Capture a task</LinkButton></div>
      </div>
    </>}

    <div className="two">
      <div className="stack" style={{ gap: 28 }}>
        <RepositoryLinks topic={topic} busy={action.busy} onLink={link} onUnlink={target => void unlink(target)} />
        {!isEmpty && <section className="section">
          <div className="between"><h2>Activity</h2><span className="eyebrow">newest first</span></div>
          {activity.map(item => <div className="relation" key={item.to + item.at}><Link to={item.to}>{item.text}</Link><Provenance parts={[item.tag]} at={item.at} /></div>)}
        </section>}
      </div>
      <aside>
        <div className="aside-block">
          <div className="between"><h3>Apps that can see this topic</h3><Link to="/apps" className="fine">Manage</Link></div>
          {apps.length === 0 && <p className="muted fine">None yet. Grants are made on the consent page when an app connects.</p>}
          {apps.map(app => <div className="between" key={app.client_id}><span style={{ fontWeight: 500 }}>{app.label}</span>
            <Light color="green" word={[(app.all_topics || app.topic_ids.includes(id)) && (app.can_write ? 'memory rw' : 'memory'), (app.task_all_topics || app.agent_task_grants.some(g => g.topic_id === id)) && 'tasks'].filter(Boolean).join(' · ')} /></div>)}
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
