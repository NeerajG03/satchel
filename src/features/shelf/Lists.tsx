import { useState } from 'react';
import { useStores } from '../../app/stores';
import { useAction, type Loaded } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import type { ProfileKind } from '../profiles/repository';
import { listsOf, type ShelfItem, type Want } from './repository';
import { Button } from '../../ui/Button';
import { SaveError } from '../../ui/Notice';

/** What a drop said, in a line, so a list line can show where it came from. */
const gist = (item: ShelfItem) => [item.note, item.transcript, item.description].find(t => t?.trim())?.trim().slice(0, 140) ?? 'A drop';
const SHOWN = 8;

/**
 * The Shelf, rearranged: one block per list Satchel made as drops called for
 * it (Books, Watch, Recipes to try), each line a tick and a title. A bigger
 * list gets a wider block. Lines are never typed in here, only dropped.
 */
export function Lists({ wants, items, profile }: { wants: Loaded<Want[]>; items: ShelfItem[]; profile: ProfileKind | 'all' }) {
  const rows = (wants.data ?? []).filter(w => profile === 'all' || !w.profile || w.profile === profile);
  if (!rows.length) return null;
  const names = listsOf(wants.data ?? []);
  return <div className="list-blocks">
    {names.map(name => {
      const mine = rows.filter(w => w.list === name);
      return mine.length ? <ListBlock key={name} name={name} lines={mine} names={names} items={items} wants={wants} /> : null;
    })}
  </div>;
}

function ListBlock({ name, lines, names, items, wants }: { name: string; lines: Want[]; names: string[]; items: ShelfItem[]; wants: Loaded<Want[]> }) {
  const stores = useStores();
  const { announce } = useReadout();
  const act = useAction('action');
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const byId = new Map(items.map(item => [item.id, item]));
  const open = lines.filter(w => w.status === 'want');
  const done = lines.filter(w => w.status === 'done');
  const shown = all ? open : open.slice(0, SHOWN);
  const id = `list-${name.replace(/\W+/g, '-').toLowerCase()}`;

  async function change(w: Want, run: () => Promise<void>, said: string) {
    setActingOn(w.id);
    const ok = await act.run(async () => { await run(); return true; });
    if (!ok) return;
    if (opened === w.id) setOpened(null);
    wants.reload();
    announce(said);
  }

  const line = (w: Want) => <li key={w.id} className={`want ${w.status}`}>
    <input type="checkbox" aria-label={w.status === 'done' ? `Not done: ${w.title}` : `Done: ${w.title}`}
      checked={w.status === 'done'} disabled={act.busy && actingOn === w.id}
      onChange={event => void change(w, () => stores.shelf.setWant(w.id, event.target.checked ? 'done' : 'want'),
        event.target.checked ? `Done: ${w.title}` : `Back on ${name}: ${w.title}`)} />
    <button type="button" className="want-what" aria-expanded={opened === w.id} onClick={() => setOpened(opened === w.id ? null : w.id)}>
      <span className="title">{w.title}</span>
      {w.detail && <span className="detail">{w.detail}</span>}
    </button>
    {opened === w.id && <div className="want-more">
      <ul className="want-sources">{w.item_ids.map(source => <li key={source} className="fine muted">
        from {byId.has(source) ? `“${gist(byId.get(source)!)}”` : 'a drop further down your Shelf'}</li>)}</ul>
      <div className="row">
        <label className="visually-hidden" htmlFor={`move-${w.id}`}>Move to list</label>
        <select id={`move-${w.id}`} className="field compact" value={w.list} disabled={act.busy}
          onChange={event => { const to = event.target.value; void change(w, () => stores.shelf.moveWant(w.id, to), `Moved to ${to}`); }}>
          {names.map(n => <option key={n} value={n}>{n === name ? `On ${n}` : `Move to ${n}`}</option>)}
        </select>
        <Button look="quiet" small disabled={act.busy} onClick={() => void change(w, () => stores.shelf.removeWant(w.id), `Removed ${w.title}`)}>Remove</Button>
      </div>
    </div>}
    {act.error && actingOn === w.id && <SaveError title="Could not change this." message={act.error} />}
  </li>;

  return <section className={`list-block${open.length > SHOWN ? ' wide' : ''}`} aria-labelledby={id}>
    <header>
      <h2 id={id}>{name}</h2>
      <span className="eyebrow">{open.length} to go{done.length ? ` · ${done.length} done` : ''}</span>
    </header>
    {open.length === 0 && <p className="fine muted">All done.</p>}
    <ul className="wants">{shown.map(line)}</ul>
    <div className="row list-block-foot">
      {open.length > SHOWN && <Button look="link" small onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${open.length}`}</Button>}
      {done.length > 0 && <Button look="link" small aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
        {showDone ? 'Hide done' : `Done · ${done.length}`}</Button>}
    </div>
    {showDone && <ul className="wants">{done.map(line)}</ul>}
  </section>;
}
