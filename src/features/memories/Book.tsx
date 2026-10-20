import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { parseScope, scopeEyebrow, scopeName, scopeQuery, topicScope } from '../../app/scope';
import { count, whenText } from '../../app/format';
import { EMPTY_CONTENT, replaceSummary, type Memory, type MemoryContent, type MemorySummary } from './model';
import { ScopePicker } from '../../shell/ScopePicker';
import { Composer } from './Composer';
import { MemoryEntry } from './MemoryEntry';
import { byDay, changeOf, dated, newestChange, newsByTopic, type Day, type TopicNews } from './ledger';
import { bookSeen, markBookSeen, type Seen } from './seen';
import { Segments } from '../../ui/Segments';
import { Empty } from '../../ui/Empty';
import { LoadError, Notice, Skeleton } from '../../ui/Notice';
import { Button } from '../../ui/Button';

const PROMPTS: MemoryContent[] = [
  { statement: 'Write answers in short, plain words, and show the code before explaining it.', name: '', more_info: '', kind: 'preference' },
  { statement: 'I work in TypeScript, React and Supabase, on Node 22 and macOS.', name: '', more_info: '', kind: 'fact' },
  { statement: 'Never use default exports, and never write a comment that repeats the code.', name: '', more_info: '', kind: 'preference' },
  { statement: 'I am in Bengaluru on IST and usually working 10 to 7.', name: '', more_info: '', kind: 'fact' },
];
type Where = 'all' | 'name' | 'statement';
const DAY_WORD: Record<Day, string> = { today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', older: 'Before that' };
// Enough to cover a busy week without the page turning back into a scroll.
const FIRST = 20;
const NOTE_FIRST = 5;

function matcher(query: string) {
  const needle = query.trim().toLowerCase();
  return (text: string) => needle.length > 0 && text.toLowerCase().includes(needle);
}

export function Book() {
  const stores = useStores();
  const navigate = useNavigate();
  const { announce } = useReadout();
  const [params, setParams] = useSearchParams();
  const scope = parseScope(params.get('scope'));
  const query = params.get('q') ?? '';
  const searchAll = params.get('all') === '1';
  const composeParam = params.get('compose') === '1';

  const topics = useLoad(() => stores.topics.list(), [stores]);
  // One load for every scope. The picker needs counts for all of them anyway,
  // and only all_memories carries the dates that tell new from said again.
  const memories = useLoad(() => stores.memories.listAll(), [stores]);
  // Only for the note's archived counts, so a failure here leaves them out
  // rather than taking the book down.
  const archived = useLoad(() => stores.memories.archived(), [stores]);
  const scopeKey = scope.kind === 'topic' ? scope.topicId : 'personal';
  const action = useAction();
  // Reading and forgetting one entry. Their failure shows under that entry,
  // because the composer that shows save errors is often closed or hidden.
  const entry = useAction('action');
  const [entryId, setEntryId] = useState<string | null>(null);

  const [content, setContent] = useState<MemoryContent>(EMPTY_CONTENT);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [expanded, setExpanded] = useState<Memory | null>(null);
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [where, setWhere] = useState<Where>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Which topics in the note are open, and which show every row.
  const [openTopics, setOpenTopics] = useState<Set<string> | null>(null);
  const [allTopics, setAllTopics] = useState<Set<string>>(new Set());
  useEffect(() => { setShowAll(false); setOpenKey(null); }, [scopeKey]);

  const hasDraft = Boolean(content.statement || content.name || content.more_info);
  const open = composerOpen || composeParam || hasDraft;
  const topicList = topics.data ?? [];
  const label = scopeName(scope, topicList);
  const topic = scope.kind === 'topic' ? topicList.find(p => p.id === scope.topicId) : undefined;
  const memoryCounts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const memory of memories.data ?? []) if (memory.topic_id) result[memory.topic_id] = (result[memory.topic_id] ?? 0) + 1;
    for (const p of topicList) result[p.id] ??= 0;
    return result;
  }, [memories.data, topicList]);

  const { inScope, all, inName, inStatement, searched, visible } = useMemo(() => {
    const matches = matcher(query);
    const everything = memories.data ?? [];
    const inScope = everything.filter(m => scope.kind === 'topic' ? m.topic_id === scope.topicId : m.topic_id === null);
    const all = searchAll && query ? everything : inScope;
    const inName = all.filter(m => matches(m.name ?? ''));
    const inStatement = all.filter(m => matches(m.statement));
    const searched = query ? all.filter(m => matches(m.name ?? '') || matches(m.statement)) : all;
    const visible = where === 'name' ? inName : where === 'statement' ? inStatement : searched;
    return { inScope, all, inName, inStatement, searched, visible };
  // scopeKey stands for scope, which is a new object on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memories.data, scopeKey, query, searchAll, where]);

  // One visit for the whole book: what was last seen, and the newest change
  // when this visit began. Both are database times, so a browser clock that
  // is off cannot hide a memory or show it twice. Taken once everything has
  // loaded, so a memory written while the page is open is not news.
  const visitRef = useRef<{ seen: Seen | null; until: string } | null>(null);
  if (!visitRef.current && memories.data && !archived.loading)
    visitRef.current = { seen: bookSeen(), until: newestChange(memories.data, archived.data ?? []) };
  const visit = visitRef.current;
  // Only once the note could have been shown. Searching hides it, so a visit
  // that was only ever a search leaves the news for next time.
  useEffect(() => { if (visit && !query) markBookSeen(visit.until); }, [visit, query]);

  const groups = useMemo(() => byDay(visible), [visible]);
  const news = useMemo(() => visit ? newsByTopic(memories.data ?? [], archived.data ?? [], visit.seen?.at ?? null, visit.until) : [],
    [memories.data, archived.data, visit]);
  const freshTotal = news.reduce((sum, topicNews) => sum + topicNews.fresh.length, 0);
  const freshTopics = news.filter(topicNews => topicNews.fresh.length > 0).length;
  const topicKey = (topicId: string | null) => topicId ?? 'personal';
  // The topic you are in starts open, so its news is one glance away.
  const isOpen = (topicId: string | null) => openTopics ? openTopics.has(topicKey(topicId)) : topicKey(topicId) === scopeKey;
  function toggleTopic(topicId: string | null) {
    const next = new Set(openTopics ?? news.filter(n => isOpen(n.topicId)).map(n => topicKey(n.topicId)));
    if (next.has(topicKey(topicId))) next.delete(topicKey(topicId)); else next.add(topicKey(topicId));
    setOpenTopics(next);
  }
  let budget = showAll || query ? Infinity : FIRST;
  const shownGroups = groups.map(group => {
    const items = group.items.slice(0, Math.max(0, budget));
    budget -= items.length;
    return { ...group, total: group.items.length, items };
  }).filter(group => group.items.length > 0);
  const hidden = visible.length - shownGroups.reduce((sum, group) => sum + group.items.length, 0);

  useFooter(query ? `${visible.length} of ${all.length} match “${query}”` : `${count(all.length, 'in the book', 'in the book')} · ${label}`,
    !memories.loading && all.length === 0 && !query ? { light: 'amber', word: topic ? 'Topic has nothing yet' : 'Nothing saved yet' } : undefined);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: key === 'q' });
  }
  function clearDraft() { setContent(EMPTY_CONTENT); setEditing(null); setDraftId(crypto.randomUUID()); setComposerOpen(false); action.clear(); if (composeParam) setParam('compose', null); }
  function highlight(text: string): ReactNode {
    if (!query.trim()) return text;
    const index = text.toLowerCase().indexOf(query.trim().toLowerCase());
    if (index < 0) return text;
    return <>{text.slice(0, index)}<mark>{text.slice(index, index + query.trim().length)}</mark>{text.slice(index + query.trim().length)}</>;
  }

  async function read(memory: MemorySummary, edit = false) {
    setEntryId(memory.id);
    const current = await entry.run(() => stores.memories.read(memory));
    if (!current) return;
    memories.replace(items => replaceSummary(items, current));
    if (edit) { setEditing(current); setContent({ statement: current.statement, name: current.name ?? '', more_info: current.more_info, kind: current.kind }); setExpanded(null); }
    else setExpanded(current);
  }
  async function save() {
    const saved = await action.run(() => editing ? stores.memories.correct(editing, content) : stores.memories.save(scope, draftId, content));
    if (!saved) return;
    memories.replace(items => replaceSummary(items, saved));
    setFreshId(saved.id);
    clearDraft();
    announce(`Saved to your book · revision ${saved.revision}`);
  }
  async function forget(memory: MemorySummary) {
    setEntryId(memory.id);
    const done = await entry.run(async () => { await stores.memories.forget(memory); return true; });
    if (!done) return;
    memories.replace(items => items.filter(item => item.id !== memory.id));
    archived.reload();
    setForgetId(null);
    if (expanded?.id === memory.id) setExpanded(null);
    // Where it went, because it did not go anywhere final. Forgetting stops a
    // memory loading; the archive is where it waits and where deleting for
    // good actually lives.
    announce('Forgotten · it is in the archive if you want it back');
  }

  function dayLine(group: (typeof shownGroups)[number]) {
    // Rows without their dates cannot say why they moved, so the head only counts them.
    if (group.day === 'older' || !group.items.some(dated)) return count(group.total, 'memory', 'memories');
    return [group.counts.new && `${group.counts.new} new`, group.counts.again && `${group.counts.again} said again`,
      group.counts.changed && `${group.counts.changed} changed`].filter(Boolean).join(' · ');
  }
  function entryFor(memory: MemorySummary, place: 'note' | 'list', tagged: boolean) {
    const key = `${place}:${memory.id}`;
    // A memory from another topic is only on screen in the note, so it is
    // corrected there.
    const here = place === 'list' || !inScope.some(item => item.id === memory.id);
    if (here && editing?.id === memory.id) return <Composer key={key} content={content} scopeLabel={label} open busy={action.busy} error={action.error} editing={editing}
      onOpen={() => undefined} onChange={setContent} onDiscard={clearDraft} onSave={() => void save()} />;
    return <Fragment key={key}><MemoryEntry memory={memory} change={changeOf(memory)} open={openKey === key}
      expanded={expanded} busy={action.busy || entry.busy} tagged={tagged} wrap={Boolean(query)}
      dim={Boolean(editing) && editing?.id !== memory.id} fresh={freshId === memory.id} confirmingForget={forgetId === key}
      canCorrect={!hasDraft} highlight={highlight}
      onToggle={() => { setOpenKey(openKey === key ? null : key); setForgetId(null); }}
      onRead={() => void read(memory)} onHide={() => setExpanded(null)} onCorrect={() => void read(memory, true)}
      onAskForget={ask => setForgetId(ask ? key : null)} onForget={() => void forget(memory)} />
      {entry.error && entryId === memory.id && openKey === key && <Notice look="error" title="Could not finish that.">{entry.error}</Notice>}</Fragment>;
  }

  function topicRow(topicNews: TopicNews<MemorySummary>) {
    const key = topicKey(topicNews.topicId);
    const name = scopeName(topicScope(topicNews.topicId), topicList);
    const open = isOpen(topicNews.topicId);
    const rows = [...topicNews.fresh, ...topicNews.again, ...topicNews.changed];
    const shown = allTopics.has(key) ? rows : rows.slice(0, NOTE_FIRST);
    const rest = [topicNews.fresh.length > 0 && 'new', topicNews.again.length > 0 && `${topicNews.again.length} said again`,
      topicNews.changed.length > 0 && `${topicNews.changed.length} changed`, topicNews.archived > 0 && `${topicNews.archived} archived`]
      .filter(Boolean).join(' · ');
    return <div key={key} className="topic">
      <button type="button" className="topic-row" aria-expanded={open} aria-controls={open ? `news-${key}` : undefined} onClick={() => toggleTopic(topicNews.topicId)}>
        <span className="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="name">{name}</span>
        <span className="n">{topicNews.fresh.length || ''}</span>
        <span className="rest">{rest}</span>
      </button>
      {open && <div className="topic-news" id={`news-${key}`}>
        {shown.map(memory => entryFor(memory, 'note', true))}
        <div className="row wrap">
          {shown.length < rows.length && <Button look="link" onClick={() => setAllTopics(new Set(allTopics).add(key))}>Show all {rows.length} for {name}</Button>}
          {key !== scopeKey && <Link to={`/book${scopeQuery(topicScope(topicNews.topicId))}`} className="fine">Open {name === 'For me' ? 'For me' : 'its book'}</Link>}
        </div>
      </div>}
    </div>;
  }

  const locked = editing ? 'Finish or discard the correction to switch scope.' : hasDraft ? 'Save or discard the draft to switch scope.' : undefined;

  return <>
    <div className="head">
      <div className="col">
        <span className="eyebrow">{scopeEyebrow(scope, topicList)}</span>
        <h1>The book.</h1>
        <p className="lede">{scope.kind === 'personal'
          ? '“For me” holds preferences and details that apply across all your work. Pick a topic from the picker when something belongs to one subject only.'
          : topic?.brief || 'Decisions and details for this topic only.'}</p>
      </div>
      <div className="row wrap" style={{ alignItems: 'flex-start' }}>
        <ScopePicker scope={scope} topics={topicList} counts={memoryCounts} locked={locked}
          onChange={next => navigate(`/book${scopeQuery(next)}`)} onNewTopic={() => navigate('/topics/new')} />
        <label className="search"><span aria-hidden="true">⌕</span>
          <input type="search" placeholder="Search this scope" aria-label="Search the book" value={query} onChange={event => setParam('q', event.target.value || null)} />
        </label>
      </div>
    </div>

    {!query && !editing && <Composer content={content} scopeLabel={label} open={open} busy={action.busy} error={action.error}
      onOpen={() => setComposerOpen(true)} onChange={next => { setContent(next); setDraftId(crypto.randomUUID()); }} onDiscard={clearDraft} onSave={() => void save()} />}

    {query && <div className="stack-tight">
      <p className="fine muted">Searching memories and their handles {searchAll ? 'in every scope you own' : 'in this scope'}.{' '}
        {searchAll ? <Button look="link" onClick={() => setParam('all', null)}>Search this scope only</Button> : <Button look="link" onClick={() => setParam('all', '1')}>Search all scopes instead</Button>}
      </p>
      <div className="between wrap">
        <Segments label="Where it matched" value={where} onChange={setWhere} items={[
          { key: 'all', label: 'Matches', count: searched.length }, { key: 'statement', label: 'In the memory', count: inStatement.length }, { key: 'name', label: 'In the handle', count: inName.length }]} />
        <Button look="quiet" small onClick={() => setParam('q', null)}>Clear</Button>
      </div>
    </div>}

    {memories.error && <LoadError what="Your book" message={memories.error} onReload={memories.reload} />}
    {memories.loading && !memories.data && <Skeleton rows={4} />}

    {memories.data && !query && all.length === 0 && <Empty title="Ideas for a first memory">
      Start with something about you. Things you end up repeating in every new chat make good first entries. Tap one to prefill the form above.
      <span className="chips" style={{ marginTop: 12 }}>
        {PROMPTS.map(prompt => <button key={prompt.name} type="button" className="chip ink button" onClick={() => { setContent(prompt); setComposerOpen(true); }}>{prompt.name}</button>)}
      </span>
    </Empty>}
    {memories.data && query && visible.length === 0 && <Empty title="Nothing matches here.">
      Memories saved in “For me” and other topics are not searched unless you widen the scope above.
    </Empty>}

    {!query && news.length > 0 && <section className="panel since" aria-labelledby="since-title">
      <h2 id="since-title" className="lead">{freshTotal > 0
        ? `${count(freshTotal, 'new memory', 'new memories')} since you last looked, in ${count(freshTopics, 'topic')}.`
        : 'Nothing new since you last looked.'}</h2>
      <p className="prov">You were last here {whenText(visit!.seen!.visited)}</p>
      <div className="topics">{news.map(topicNews => topicRow(topicNews))}</div>
    </section>}

    {query ? <div>{visible.map(memory => entryFor(memory, 'list', false))}</div>
      : shownGroups.map(group => <section key={group.day} className="day" aria-labelledby={`day-${group.day}`}>
        <div className="day-head"><h2 id={`day-${group.day}`}>{DAY_WORD[group.day]}</h2><span className="prov">{dayLine(group)}</span></div>
        {group.items.map(memory => entryFor(memory, 'list', group.day !== 'older'))}
      </section>)}
    {hidden > 0 && <Button look="link" onClick={() => setShowAll(true)}>Show all {all.length}</Button>}
    {searchAll && query && <p className="fine muted">Results from every scope. <Link to={`/book${scopeQuery(scope)}`}>Back to {label}</Link>.</p>}
    {!query && <p className="fine muted" style={{ paddingTop: 16 }}>
      Anything forgotten, replaced or finished waits in <Link to="/book/archive">the archive</Link>.
    </p>}
  </>;
}
