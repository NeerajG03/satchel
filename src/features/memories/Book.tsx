import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { parseScope, scopeEyebrow, scopeName, scopeQuery } from '../../app/scope';
import { count } from '../../app/format';
import { EMPTY_CONTENT, replaceSummary, type Memory, type MemoryContent, type MemorySummary } from './model';
import { ScopePicker } from '../../shell/ScopePicker';
import { Composer } from './Composer';
import { MemoryEntry } from './MemoryEntry';
import { Segments } from '../../ui/Segments';
import { Empty } from '../../ui/Empty';
import { LoadError, Skeleton } from '../../ui/Notice';
import { Button } from '../../ui/Button';

const PROMPTS: MemoryContent[] = [
  { statement: 'Write answers in short, plain words, and show the code before explaining it.', name: '', more_info: '', kind: 'preference' },
  { statement: 'I work in TypeScript, React and Supabase, on Node 22 and macOS.', name: '', more_info: '', kind: 'fact' },
  { statement: 'Never use default exports, and never write a comment that repeats the code.', name: '', more_info: '', kind: 'preference' },
  { statement: 'I am in Bengaluru on IST and usually working 10 to 7.', name: '', more_info: '', kind: 'fact' },
];
type Where = 'all' | 'name' | 'statement';

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

  const projects = useLoad(() => stores.projects.list(), [stores]);
  const memories = useLoad(() => searchAll ? stores.memories.listAll() : stores.memories.list(scope), [stores, scope.kind, scope.kind === 'project' ? scope.projectId : '', searchAll]);
  const counts = useLoad(() => stores.memories.listAll(), [stores]);
  const action = useAction();

  const [content, setContent] = useState<MemoryContent>(EMPTY_CONTENT);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [expanded, setExpanded] = useState<Memory | null>(null);
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [where, setWhere] = useState<Where>('all');

  const hasDraft = Boolean(content.statement || content.name || content.more_info);
  const open = composerOpen || composeParam || hasDraft;
  const projectList = projects.data ?? [];
  const label = scopeName(scope, projectList);
  const project = scope.kind === 'project' ? projectList.find(p => p.id === scope.projectId) : undefined;
  const memoryCounts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const memory of counts.data ?? []) if (memory.project_id) result[memory.project_id] = (result[memory.project_id] ?? 0) + 1;
    for (const p of projectList) result[p.id] ??= 0;
    return result;
  }, [counts.data, projectList]);

  const matches = matcher(query);
  const all = memories.data ?? [];
  const inName = all.filter(m => matches(m.name ?? ''));
  const inStatement = all.filter(m => matches(m.statement));
  const searched = query ? all.filter(m => matches(m.name ?? '') || matches(m.statement)) : all;
  const visible = where === 'name' ? inName : where === 'statement' ? inStatement : searched;

  useFooter(query ? `${visible.length} of ${all.length} match “${query}”` : `${count(all.length, 'in the book', 'in the book')} · ${label}`,
    !memories.loading && all.length === 0 && !query ? { light: 'amber', word: project ? 'Project has nothing yet' : 'Nothing saved yet' } : undefined);

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
    const current = await action.run(() => stores.memories.read(memory));
    if (!current) return;
    memories.replace(items => replaceSummary(items, current));
    if (edit) { setEditing(current); setContent({ statement: current.statement, name: current.name ?? '', more_info: current.more_info, kind: current.kind }); setExpanded(null); }
    else setExpanded(current);
  }
  async function save() {
    const saved = await action.run(() => editing ? stores.memories.correct(editing, content) : stores.memories.save(scope, draftId, content));
    if (!saved) return;
    memories.replace(items => replaceSummary(items, saved));
    counts.reload();
    setFreshId(saved.id);
    clearDraft();
    announce(`Saved to your book · revision ${saved.revision}`);
  }
  async function forget(memory: MemorySummary) {
    const done = await action.run(async () => { await stores.memories.forget(memory); return true; });
    if (!done) return;
    memories.replace(items => items.filter(item => item.id !== memory.id));
    counts.reload();
    setForgetId(null);
    if (expanded?.id === memory.id) setExpanded(null);
    // Where it went, because it did not go anywhere final. Forgetting stops a
    // memory loading; the archive is where it waits and where deleting for
    // good actually lives.
    announce('Forgotten · it is in the archive if you want it back');
  }

  const locked = editing ? 'Finish or discard the correction to switch scope.' : hasDraft ? 'Save or discard the draft to switch scope.' : undefined;

  return <>
    <div className="head">
      <div className="col">
        <span className="eyebrow">{scopeEyebrow(scope, projectList)}</span>
        <h1>The book.</h1>
        <p className="lede">{scope.kind === 'personal'
          ? '“For me” holds preferences and details that apply across all your work. Pick a project from the picker when something belongs to one effort only.'
          : project?.brief || 'Decisions and details for this project only.'}</p>
      </div>
      <div className="row wrap" style={{ alignItems: 'flex-start' }}>
        <ScopePicker scope={scope} projects={projectList} counts={memoryCounts} locked={locked}
          onChange={next => navigate(`/book${scopeQuery(next)}`)} onNewProject={() => navigate('/projects/new')} />
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

    {memories.error && <LoadError what="Your book" onReload={memories.reload} />}
    {memories.loading && !memories.data && <Skeleton rows={4} />}

    {memories.data && !query && all.length === 0 && <Empty title="Ideas for a first memory">
      Start with something about you. Things you end up repeating in every new chat make good first entries. Tap one to prefill the form above.
      <span className="chips" style={{ marginTop: 12 }}>
        {PROMPTS.map(prompt => <button key={prompt.name} type="button" className="chip ink button" onClick={() => { setContent(prompt); setComposerOpen(true); }}>{prompt.name}</button>)}
      </span>
    </Empty>}
    {memories.data && query && visible.length === 0 && <Empty title="Nothing matches here.">
      Memories saved in “For me” and other projects are not searched unless you widen the scope above.
    </Empty>}

    <div>
      {visible.map(memory => editing?.id === memory.id
        ? <Composer key={memory.id} content={content} scopeLabel={label} open busy={action.busy} error={action.error} editing={editing}
          onOpen={() => undefined} onChange={setContent} onDiscard={clearDraft} onSave={() => void save()} />
        : <MemoryEntry key={memory.id} memory={memory} expanded={expanded} busy={action.busy}
        dim={Boolean(editing) && editing?.id !== memory.id} fresh={freshId === memory.id} confirmingForget={forgetId === memory.id}
        canCorrect={!hasDraft} highlight={highlight}
        onRead={() => void read(memory)} onHide={() => setExpanded(null)} onCorrect={() => void read(memory, true)}
        onAskForget={ask => setForgetId(ask ? memory.id : null)} onForget={() => void forget(memory)} />)}
    </div>
    {searchAll && query && <p className="fine muted">Results from every scope. <Link to={`/book${scopeQuery(scope)}`}>Back to {label}</Link>.</p>}
    {!query && <p className="fine muted" style={{ paddingTop: 16 }}>
      Anything forgotten, replaced or finished waits in <Link to="/book/archive">the archive</Link>.
    </p>}
  </>;
}
