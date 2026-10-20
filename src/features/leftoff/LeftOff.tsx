import { Link } from 'react-router';
import { useStores } from '../../app/stores';
import { useLoad } from '../../app/useLoad';
import { useFooter } from '../../app/readout';
import { useAuth } from '../../app/auth';
import { count } from '../../app/format';
import { topicScope, scopeName, scopeQuery } from '../../app/scope';
import { LinkButton } from '../../ui/Button';
import { Light } from '../../ui/Light';
import { LoadError, Skeleton } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';
import { accountHandle } from '../../shell/Header';
import { LeftOffEmpty } from './LeftOffEmpty';
import { newestChange, newsByTopic } from '../memories/ledger';
import { bookSeen } from '../memories/seen';

export function LeftOff() {
  const stores = useStores();
  const { user } = useAuth();
  const page = useLoad(async () => {
    const [topics, memories, connections, archived] = await Promise.all([
      stores.topics.list(), stores.memories.listAll(), stores.connections.list(),
      // Only for the counts below, so it never takes the page down.
      stores.memories.archived().catch(() => []),
    ]);
    return { topics, memories, connections, archived };
  }, [stores]);

  const data = page.data;
  const firstRun = data && data.memories.length === 0 && data.connections.filter(c => !c.revoked_at).length === 0;
  const newest = data?.memories[0];
  const live = data?.connections.filter(c => !c.revoked_at) ?? [];
  // Read, never marked: only opening the book counts as having looked.
  const seen = bookSeen();
  const news = data ? newsByTopic(data.memories, data.archived, seen?.at ?? null, newestChange(data.memories, data.archived)) : [];
  const freshNews = news.filter(topicNews => topicNews.fresh.length > 0);
  const freshTotal = freshNews.reduce((sum, topicNews) => sum + topicNews.fresh.length, 0);

  useFooter(data ? `${count(data.memories.length, 'in the book', 'in the book')} · ${count(data.topics.length, 'topic')} · ${count(live.length, 'app')}` : '',
    firstRun ? { light: 'amber', word: 'Nothing saved yet' } : undefined);

  if (page.error) return <><h1>Where you left off.</h1><LoadError what="Your book" message={page.error} onReload={page.reload} /><Skeleton rows={4} /></>;
  if (!data) return <><h1>Where you left off.</h1><Skeleton rows={5} /></>;
  if (firstRun) return <LeftOffEmpty name={accountHandle(user)} topics={data.topics} />;

  return <>
    <div className="head">
      <div className="col"><span className="eyebrow">Left off</span><h1>Where you left off.</h1></div>
      <div className="row"><LinkButton to="/book">Open the book</LinkButton><LinkButton to="/book?compose=1" look="primary">Write something down</LinkButton></div>
    </div>
    <div className="two">
      {freshTotal > 0 ? <section className="section">
        <div className="between"><h2>Since you last looked</h2><span className="eyebrow">{count(freshNews.length, 'topic')}</span></div>
        <p className="serif" style={{ fontSize: 19, lineHeight: 1.4 }}>{count(freshTotal, 'new memory', 'new memories')} in {count(freshNews.length, 'topic')}.</p>
        <div>{freshNews.map(topicNews => <Link key={topicNews.topicId ?? 'personal'} className="between news-row"
          to={`/book${scopeQuery(topicScope(topicNews.topicId))}`}>
          <span className="serif" style={{ fontSize: 18 }}>{scopeName(topicScope(topicNews.topicId), data.topics)}</span>
          <span className="prov">{topicNews.fresh.length} new</span>
        </Link>)}</div>
        <Link to="/book" className="fine">See what came in</Link>
      </section> : <section className="section">
        <div className="between"><h2>Last thing saved</h2></div>
        {newest ? <>
          <p className="serif" style={{ fontSize: 19, lineHeight: 1.4 }}>“{newest.statement}”</p>
          <Provenance parts={[newest.name, scopeName(topicScope(newest.topic_id), data.topics), `revision ${newest.revision}`]} at={newest.updated_at} />
          <Link to={`/book${scopeQuery(topicScope(newest.topic_id))}`} className="fine">Open the book</Link>
        </> : <p className="muted fine">Nothing in the book yet. <Link to="/book">Write the first thing down</Link>.</p>}
      </section>}
      <aside>
        <div className="aside-block">
          <div className="between"><h3>Your apps</h3><Link to="/apps" className="fine">Manage apps</Link></div>
          {live.length === 0 && <p className="muted fine">No apps connected. <Link to="/apps">See the steps</Link>.</p>}
          {live.map(app => <div className="between" key={app.client_id}>
            <span style={{ fontWeight: 500 }}>{app.label}</span>
            <Light color="green" word={app.can_write ? 'reads and saves' : 'reads only'} />
          </div>)}
        </div>
      </aside>
    </div>
  </>;
}
