import { Link, useLocation, useNavigate } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count, whenText } from '../../app/format';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { Chip } from '../../ui/Chip';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { NewTopicSheet } from './NewTopicSheet';

export function TopicList() {
  const stores = useStores();
  const navigate = useNavigate();
  const location = useLocation();
  const { announce } = useReadout();
  const creating = location.pathname.endsWith('/new');
  const page = useLoad(async () => {
    const [topics, memories, tasks, connections] = await Promise.all([stores.topics.list(), stores.memories.listAll(), stores.tasks.listAll(), stores.connections.list()]);
    return { topics, memories, tasks, connections };
  }, [stores]);
  const action = useAction();
  const data = page.data;
  const live = data?.topics.filter(p => !p.merged_into) ?? [];
  const merged = data?.topics.filter(p => p.merged_into) ?? [];
  useFooter(data ? `${count(live.length, 'topic')}` : '');

  async function create(id: string, name: string, brief: string, slug: string) {
    const created = await action.run(() => stores.topics.create(id, name, brief, slug));
    if (!created) return;
    announce(`Topic created · ${created.name}`);
    navigate(`/topics/${created.id}`, { replace: true });
  }
  async function unmerge(id: string) {
    const topic = data?.topics.find(p => p.id === id);
    if (!topic) return;
    const done = await action.run(async () => { await stores.topics.unmerge(topic); return true; });
    if (!done) return;
    announce(`Merge undone · ${topic.name} is back`);
    page.reload();
  }
  const stats = (topicId: string) => {
    const memories = data?.memories.filter(m => m.topic_id === topicId).length ?? 0;
    const tasks = data?.tasks.filter(t => t.topic_id === topicId && t.status !== 'done').length ?? 0;
    const apps = data?.connections.filter(c => !c.revoked_at && (c.all_topics || c.task_all_topics || c.topic_ids.includes(topicId) || c.agent_task_grants.some(g => g.topic_id === topicId))).length ?? 0;
    const latest = [...(data?.memories.filter(m => m.topic_id === topicId).map(m => m.updated_at) ?? []), ...(data?.tasks.filter(t => t.topic_id === topicId).map(t => t.last_activity_at) ?? [])].sort().at(-1);
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
      <tbody>{live.map(topic => {
        const s = stats(topic.id);
        const empty = s.memories === 0 && s.tasks === 0;
        return <tr key={topic.id}>
          <td><Link to={`/topics/${topic.id}`} className="serif" style={{ fontSize: 20, color: 'var(--ink)' }}>{topic.name}</Link>
            {topic.made_by === 'satchel' && <> <Chip>made by Satchel</Chip></>}
            <div className="fine muted">{empty ? 'Nothing saved here yet.' : topic.brief || 'No brief yet.'}</div>
            {topic.topic_repositories.length === 0 ? <div className="fine muted">No repositories linked</div>
              : <div className="fine mono muted">{topic.topic_repositories.map(link => link.repository).join(' · ')}</div>}</td>
          <td className="num">{s.memories}</td><td className="num">{s.tasks}</td><td className="num">{s.apps}</td>
          <td className="fine muted">{s.latest ? whenText(s.latest) : '—'}</td>
        </tr>;
      })}</tbody>
    </table>}
    {merged.length > 0 && <section className="section">
      <div className="between"><h2>Merged</h2><span className="eyebrow">kept so you can undo</span></div>
      {action.error && !creating && <SaveError message={action.error} />}
      {merged.map(topic => {
        const into = data?.topics.find(p => p.id === topic.merged_into);
        return <div className="between" key={topic.id}>
          <span>{topic.name} <span className="muted fine">went into {into?.name ?? 'another topic'}</span></span>
          <Button small disabled={action.busy} onClick={() => void unmerge(topic.id)}>Undo merge</Button>
        </div>;
      })}
    </section>}
    {creating && data && <NewTopicSheet topics={data.topics} busy={action.busy} error={action.error} onCancel={() => navigate('/topics')} onCreate={(id, name, brief, slug) => void create(id, name, brief, slug)} />}
  </>;
}
