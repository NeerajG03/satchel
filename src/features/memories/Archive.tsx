import { useState } from 'react';
import { Link } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count } from '../../app/format';
import { endedWhy, kindLabel, type ArchivedMemory } from './model';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';

/** What stopped loading, and the way back.
 *
 *  This is the page that makes the rest of the design honest. Consolidation
 *  applies itself in the background with nobody watching, and the only reason
 *  that is acceptable is that nothing it does is out of reach. Without
 *  somewhere to see and undo it, "nothing is destroyed" is a claim about the
 *  schema rather than something a person can act on. */
export function Archive() {
  const stores = useStores();
  const { announce } = useReadout();
  const archived = useLoad(() => stores.memories.archived(), [stores]);
  const action = useAction();
  const [destroying, setDestroying] = useState<string | null>(null);
  const rows = archived.data ?? [];
  useFooter(archived.data ? `${count(rows.length, 'archived', 'archived')}` : '');

  async function restore(memory: ArchivedMemory) {
    const done = await action.run(async () => { await stores.memories.restore(memory); return true; });
    if (!done) return;
    archived.replace(items => items.filter(item => item.id !== memory.id));
    announce('Back in your book');
  }
  async function destroy(memory: ArchivedMemory) {
    const done = await action.run(async () => { await stores.memories.destroy(memory); return true; });
    if (!done) return;
    archived.replace(items => items.filter(item => item.id !== memory.id));
    setDestroying(null);
    announce('Deleted for good · its history went with it');
  }

  return <>
    <div className="head">
      <div className="col">
        <span className="eyebrow">The book · archive</span>
        <h1>Not loading any more.</h1>
        <p className="lede">Memories you forgot, ones replaced by something newer, and things you
          wanted that are now done. Nothing here reaches an agent. Everything here can come back.</p>
      </div>
      <Button onClick={archived.reload} disabled={archived.loading}>Reload</Button>
    </div>

    {archived.error && <LoadError what="The archive" onReload={archived.reload} />}
    {archived.loading && !archived.data && <Skeleton rows={3} />}
    {action.error && <SaveError message={action.error} />}

    {archived.data && rows.length === 0 && <Empty title="Nothing has been put aside">
      When you forget a memory, or Satchel replaces one with something newer, or something you
      wanted gets done, it waits here instead of disappearing.
    </Empty>}

    <div>{rows.map(memory => <article className="entry" key={memory.id}>
      <h2 className="title">{memory.statement}</h2>
      <Provenance parts={[endedWhy(memory), kindLabel(memory.kind).toLowerCase(),
        memory.ended_note || false, memory.project_id ? false : 'for me']}
        at={memory.ended_at ?? memory.expires_at ?? memory.updated_at} />
      <div className="actions">
        <Button small disabled={action.busy} onClick={() => void restore(memory)}>Put it back</Button>
        <Button look="quiet" small disabled={action.busy} aria-expanded={destroying === memory.id}
          onClick={() => setDestroying(destroying === memory.id ? null : memory.id)}>Delete for good</Button>
      </div>
      {destroying === memory.id && <div className="notice" role="group" aria-label="Delete this memory for good?">
        <strong>Delete for good?</strong>
        <p>This is the only thing in Satchel that really destroys something. The memory and its whole
          history go, and nothing can bring them back.</p>
        <div className="actions">
          <Button small disabled={action.busy} onClick={() => setDestroying(null)}>Keep it</Button>
          <Button look="danger" small disabled={action.busy} onClick={() => void destroy(memory)}>Delete for good</Button>
        </div>
      </div>}
    </article>)}</div>

    <p className="fine muted" style={{ paddingTop: 16 }}><Link to="/book">Back to the book</Link>.</p>
  </>;
}
