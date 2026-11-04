import { useState } from 'react';
import { useStores } from '../../app/stores';
import { useAction, type Loaded } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import { count } from '../../app/format';
import type { ProfileKind } from '../profiles/repository';
import { listsOf, type ShelfItem, type Want } from './repository';
import { Button } from '../../ui/Button';
import { SaveError } from '../../ui/Notice';

/** What a drop said, in a line, so a list line can show where it came from. */
const gist = (item: ShelfItem) => [item.note, item.transcript, item.description].find(t => t?.trim())?.trim().slice(0, 140) ?? 'A drop';

/**
 * The Shelf, rearranged: whatever the person is collecting (books, films,
 * places, recipes) one line each, on lists Satchel made as drops called for
 * them, merged when two drops name the same thing. A line is ticked when
 * done; it is never typed in here, only dropped.
 */
export function Lists({ wants, items, profile }: { wants: Loaded<Want[]>; items: ShelfItem[]; profile: ProfileKind | 'all' }) {
  const stores = useStores();
  const { announce } = useReadout();
  const act = useAction('action');
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const byId = new Map(items.map(item => [item.id, item]));
  const rows = (wants.data ?? []).filter(w => profile === 'all' || !w.profile || w.profile === profile);
  if (!rows.length) return null;

  async function change(w: Want, run: () => Promise<void>, said: string) {
    setActingOn(w.id);
    const done = await act.run(async () => { await run(); return true; });
    if (!done) return;
    wants.reload();
    announce(said);
  }

  const names = listsOf(wants.data ?? []);
  return <>{names.map(label => {
    const key = label;
    const open = rows.filter(w => w.list === key && w.status === 'want');
    const done = rows.filter(w => w.list === key && w.status === 'done');
    if (!open.length && !done.length) return null;
    const line = (w: Want) => <li key={w.id} className={`want ${w.status}`}>
      <label className="want-tick">
        <input type="checkbox" checked={w.status === 'done'} disabled={act.busy && actingOn === w.id}
          onChange={event => void change(w, () => stores.shelf.setWant(w.id, event.target.checked ? 'done' : 'want'),
            event.target.checked ? `Done: ${w.title}` : `Back on ${label}: ${w.title}`)} />
        <span className="title">{w.title}</span>
        {w.detail && <span className="muted"> · {w.detail}</span>}
      </label>
      <div className="row want-actions">
        <Button look="link" small aria-expanded={showing === w.id} onClick={() => setShowing(showing === w.id ? null : w.id)}>
          {w.item_ids.length > 1 ? `from ${w.item_ids.length} drops` : 'from a drop'}</Button>
        <label className="visually-hidden" htmlFor={`list-${w.id}`}>Move to list</label>
        <select id={`list-${w.id}`} className="field compact" value={w.list} disabled={act.busy && actingOn === w.id}
          onChange={event => { const to = event.target.value;
            void change(w, () => stores.shelf.moveWant(w.id, to), `Moved to ${to}`); }}>
          {names.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <Button look="quiet" small disabled={act.busy && actingOn === w.id}
          onClick={() => void change(w, () => stores.shelf.removeWant(w.id), `Removed ${w.title}`)}>Remove</Button>
      </div>
      {showing === w.id && <ul className="want-sources">{w.item_ids.map(id => <li key={id} className="fine muted">
        {byId.has(id) ? `“${gist(byId.get(id)!)}”` : 'A drop further down your Shelf'}</li>)}</ul>}
      {act.error && actingOn === w.id && <SaveError title="Could not change this." message={act.error} />}
    </li>;
    return <details key={key} className="shelf-section shelf-list" open>
      <summary><span className="name">{label}</span><span className="eyebrow">{count(open.length, 'to go', 'to go')}</span></summary>
      <ul className="wants">{open.map(line)}</ul>
      {done.length > 0 && <details className="wants-done">
        <summary className="fine muted">Done · {done.length}</summary>
        <ul className="wants">{done.map(line)}</ul>
      </details>}
    </details>;
  })}</>;
}
