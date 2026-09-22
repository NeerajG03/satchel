import { useCallback, useEffect, useState } from 'react';
import { useStores } from '../../app/stores';
import { errorMessage } from '../../client';
import { useLoad } from '../../app/useLoad';
import { useFooter } from '../../app/readout';
import { actorLabel, count } from '../../app/format';
import { handleOf } from '../memories/model';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { Notice } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';
import { Segments } from '../../ui/Segments';
import { GROUP, KIND_LABEL, summarize, summarizeRun, type Activity as Item, type ActivityKind } from './model';

type Group = 'all' | 'requests' | 'documents' | 'memory';

/** A label and a value, for the facts that are one line each. Deliberately
 *  not the `.rows` grid from the task timeline: these are machine readings,
 *  so they are mono and they keep their own column. */
function Facts({ rows }: { rows: [string, string | number | null | undefined][] }) {
  const present = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!present.length) return null;
  return <dl className="facts">{present.map(([label, value]) =>
    <div key={label} style={{ display: 'contents' }}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>;
}

/** Text a model was sent or sent back. Scrolls rather than truncating: a
 *  prompt cut off at the interesting part is the reason this page exists. */
function Readout({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return <div className="stack-tight">
    <span className="eyebrow">{label}</span>
    <pre className="readout">{text}</pre>
  </div>;
}

/** What a model was sent and what it said, read when someone opens the row.
 *
 *  These are whole model prompts, capped at 40,000 and 200,000 characters. The
 *  feed used to select them to render one line per row, which on this database
 *  was already 939 KB across 123 router runs with another written every turn.
 *  Nothing reads them until someone asks for one. */
function RunText({ kind, id }: { kind: 'capture' | 'consolidation'; id: string }) {
  const stores = useStores();
  const text = useLoad(() => stores.activity.runText(kind, id), [stores, kind, id]);
  if (text.loading) return <p className="muted fine">Reading…</p>;
  if (text.error) return <Notice look="error" title="Could not read it">{text.error}</Notice>;
  return <>
    <Readout label="Sent" text={text.data?.prompt ?? ''} />
    <Readout label="Returned" text={text.data?.response ?? null} />
  </>;
}

function Conversation({ id }: { id: string }) {
  const stores = useStores();
  const turns = useLoad(() => stores.activity.turns(id), [stores, id]);
  if (turns.loading) return <p className="muted fine">Reading…</p>;
  if (turns.error) return <Notice look="error" title="Could not read it">{turns.error}</Notice>;
  if (!turns.data?.length) return <p className="muted fine">No turns were kept.</p>;
  return <div className="stack-tight">
    <span className="eyebrow">The conversation</span>
    {turns.data.map(turn => <div key={turn.id} className="turn">
      <span className="who">{turn.role}</span>
      <pre className="readout">{turn.content}</pre>
    </div>)}
  </div>;
}

function Detail({ item, apps }: { item: Item; apps: { client_id: string; label: string }[] }) {
  if (item.kind === 'session' || item.kind === 'prompt') {
    const it = item.detail;
    return <>
      <Facts rows={[['session', it.session_key], ['event', it.event], ['matched', it.matched],
        ['in scope', it.in_scope], ['tokens', it.tokens],
        ['injected', it.memory_ids.map(handleOf).join(' ') || 'nothing']]} />
      <Readout label="What was typed" text={it.query} />
    </>;
  }
  if (item.kind === 'capture') {
    const run = item.detail;
    return <>
      <Facts rows={[['session', run.session_key], ['model', run.model],
        ['kept', run.kept], ['dropped', run.dropped], ['error', run.error]]} />
      <RunText kind="capture" id={run.id} />
    </>;
  }
  if (item.kind === 'consolidation') {
    const run = item.detail;
    return <>
      <Facts rows={[['model', run.model], ['trace', run.trace_id], ['document', run.document_id],
        ['read through turn', run.through], ['added', run.added], ['extended', run.extended],
        ['replaced', run.replaced], ['retired', run.retired], ['affirmed', run.affirmed],
        ['rejected', run.dropped], ['tokens in', run.input_tokens], ['tokens out', run.output_tokens],
        ['took', run.duration_ms === null ? null : `${run.duration_ms} ms`], ['error', run.error]]} />
      <RunText kind="consolidation" id={run.id} />
    </>;
  }
  if (item.kind === 'document') {
    const doc = item.detail;
    return <>
      <Facts rows={[['session', doc.session_key], ['scope', doc.project_slug ?? 'personal'],
        ['turns', doc.turns], ['characters', doc.chars.toLocaleString()],
        ['started', new Date(doc.started_at).toLocaleString()],
        ['consolidated', doc.consolidated_at ? `through turn ${doc.consolidated_through}` : 'not yet'],
        ['stops accepting turns', doc.truncated_at ? new Date(doc.truncated_at).toLocaleString() : null],
        ['deleted after', new Date(doc.expires_at).toLocaleDateString()]]} />
      <Conversation id={doc.id} />
    </>;
  }
  const event = item.detail;
  return <>
    <Facts rows={[['memory', handleOf(event.memory_id)], ['by', actorLabel(event.actor, apps)],
      ['why', event.reason], ['trace', event.trace_id], ['from document', event.document_id]]} />
    <Readout label="Before" text={event.before} />
    <Readout label="After" text={event.after} />
  </>;
}

export function Activity() {
  const stores = useStores();
  const [group, setGroup] = useState<Group>('all');
  const [open, setOpen] = useState('');
  // Nothing runs the background pass on its own for you. The hooks record the
  // conversation; reading it back and deciding what the memory set should be
  // is a model call, and a model call that happens without anyone asking is
  // not something to switch on quietly. This button is the asking.
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<{ look: 'ok' | 'error'; text: string } | null>(null);
  const feed = usePagedActivity();
  const apps = useLoad(() => stores.connections.list(), [stores]);

  async function consolidate() {
    setRunning(true);
    setOutcome(null);
    try {
      const result = await stores.activity.consolidate();
      setOutcome({ look: 'ok', text: summarizeRun(result) });
      // Whatever it did is in this feed, so it has to be the feed you are
      // looking at rather than the one from before you pressed the button.
      feed.reload();
    } catch (error) {
      setOutcome({ look: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  }
  const items = feed.items.filter(item => group === 'all' || GROUP[item.kind] === group);
  const tally = (of: Group) => feed.items.filter(item => of === 'all' || GROUP[item.kind] === of).length;
  // "so far", because this is a page rather than the lot. A count that reads
  // like a total when it is the first 25 of a few thousand is the kind of
  // number people plan around.
  useFooter(feed.loaded ? `${count(feed.items.length, 'record')} so far · newest first` : '');

  return <>
    <div className="head">
      <div className="col">
        <span className="eyebrow">Developer</span>
        <h1>What Satchel did.</h1>
        <p className="muted">Every request that came in, every conversation kept, and every change to a
          memory, in the order it happened. Yours alone.</p>
      </div>
      <div className="actions">
        <Button onClick={feed.reload} disabled={feed.loading}>Reload</Button>
        <Button look="primary" onClick={consolidate} disabled={running}>
          {running ? 'Reading…' : 'Consolidate now'}
        </Button>
      </div>
    </div>

    {outcome && <Notice look={outcome.look === 'ok' ? 'plain' : 'error'}
      title={outcome.look === 'ok' ? 'Consolidation ran' : 'Consolidation did not run'}>
      {outcome.text}
    </Notice>}

    <Segments label="Filter activity" value={group} onChange={setGroup} items={[
      { key: 'all', label: 'All', count: tally('all') },
      { key: 'requests', label: 'Requests', count: tally('requests') },
      { key: 'documents', label: 'Documents', count: tally('documents') },
      { key: 'memory', label: 'Memory', count: tally('memory') },
    ]} />

    {feed.error && <Notice look="error" title="Could not load activity"
      actions={<Button small onClick={feed.reload}>Reload</Button>}>{feed.error}</Notice>}
    {feed.loading && !feed.loaded && <div className="skeleton" aria-hidden="true">
      {[0, 1, 2, 3].map(n => <div key={n} className="entry"><p className="desc">&nbsp;</p></div>)}
    </div>}

    {feed.loaded && !feed.error && items.length === 0 && <Empty title="Nothing here yet">
      {group === 'all'
        ? 'Open a session in a connected agent and this fills up: the session start, every prompt, the conversation as it is kept, and anything the memory set gains or loses.'
        : 'Nothing of this kind in the last few records. Try All.'}
    </Empty>}

    <div className="timeline">{items.map(item => {
      const expanded = open === item.id;
      return <article className="entry" key={`${item.kind}-${item.id}`}>
        <div className="between">
          <span className={`eyebrow kind ${item.kind}`}>{KIND_LABEL[item.kind as ActivityKind]}</span>
          <Provenance parts={[]} at={item.at} />
        </div>
        <p className="desc">{summarize(item)}</p>
        <div className="actions">
          <Button look="quiet" small aria-expanded={expanded}
            onClick={() => setOpen(expanded ? '' : item.id)}>
            {expanded ? 'Hide' : 'Look'}
          </Button>
        </div>
        {expanded && <div className="stack-tight detail"><Detail item={item} apps={apps.data ?? []} /></div>}
      </article>;
    })}</div>

    {feed.loaded && feed.more && <div className="actions" style={{ paddingTop: 16 }}>
      <Button onClick={feed.showMore} disabled={feed.loading}>
        {feed.loading ? 'Reading…' : 'Show older'}
      </Button>
      {group !== 'all' && <span className="fine muted">
        Older records of every kind, not just {group}.
      </span>}
    </div>}
  </>;
}

/** The feed, a page at a time.
 *
 *  The cursor is the timestamp of the last row shown, not an offset. The feed
 *  merges six sources fetched separately, so an offset into the merge means
 *  nothing, and rows land while someone is reading.
 *
 *  The cursor is inclusive and duplicates are dropped here, because two
 *  sources can share a microsecond and excluding the boundary would silently
 *  skip whichever one missed the previous page. A page that adds nothing new
 *  is the end, which also stops a run of identical timestamps looping. */
function usePagedActivity(limit = 25) {
  const stores = useStores();
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const fetchPage = useCallback(async (before: string | null) => {
    setLoading(true);
    setError('');
    try {
      const page = await stores.activity.recent({ limit, before });
      setItems(current => {
        const seen = new Set(before === null ? [] : current.map(item => `${item.kind}-${item.id}`));
        const added = page.items.filter(item => !seen.has(`${item.kind}-${item.id}`));
        setMore(page.more && (before === null || added.length > 0));
        return before === null ? page.items : [...current, ...added];
      });
      setLoaded(true);
    } catch (reason) {
      setError(errorMessage(reason, 'load'));
    } finally {
      setLoading(false);
    }
  }, [stores, limit]);

  useEffect(() => { void fetchPage(null); }, [fetchPage]);

  return {
    items, more, loading, loaded, error,
    reload: useCallback(() => { void fetchPage(null); }, [fetchPage]),
    showMore: useCallback(() => {
      const last = items[items.length - 1];
      if (last) void fetchPage(last.at);
    }, [fetchPage, items]),
  };
}
