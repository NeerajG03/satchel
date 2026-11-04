import { useState } from 'react';
import { useStores } from '../../app/stores';
import { useAction, useLoad, type Loaded } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import { PROFILE_LABEL, type ProfileKind } from '../profiles/repository';
import { whenOf, type Suggestion } from './repository';
import { Button, LinkButton } from '../../ui/Button';
import { SaveError } from '../../ui/Notice';

/**
 * To-dos and events Satchel found in what you dropped, waiting for you.
 * Nothing reaches a calendar or a to-do list until you add it.
 */
export function Suggestions({ loaded, profile = 'all' }: { loaded: Loaded<Suggestion[]>; profile?: ProfileKind | 'all' }) {
  const stores = useStores();
  const { announce } = useReadout();
  const act = useAction('action');
  const [actingOn, setActingOn] = useState<string | null>(null);
  // A suggestion Satchel could not place gets its profile picked here.
  const [picked, setPicked] = useState<Record<string, ProfileKind>>({});
  const any = (loaded.data ?? []).length > 0;
  // Only asked when there is something to add.
  const links = useLoad(() => any ? stores.google.links() : Promise.resolve([]), [stores, any]);
  const linkedTo = new Set((links.data ?? []).map(l => l.profile));
  // One Satchel could not place shows under both profiles until it is picked.
  const rows = (loaded.data ?? []).filter(s => profile === 'all' || !s.profile || s.profile === profile);
  if (!loaded.data) return null;

  async function add(s: Suggestion, profile: ProfileKind) {
    setActingOn(s.id);
    const made = await act.run(() => stores.google.add(s, profile));
    if (!made) return;
    loaded.replace(list => list.filter(row => row.id !== s.id));
    announce(made.kind === 'task' ? `Added to ${PROFILE_LABEL[profile]} Google Tasks` : `Added to ${PROFILE_LABEL[profile]} Google Calendar`);
  }

  async function dismiss(s: Suggestion) {
    setActingOn(s.id);
    const done = await act.run(async () => { await stores.shelf.dismiss(s); return true; });
    if (!done) return;
    loaded.replace(list => list.filter(row => row.id !== s.id));
    announce('Dismissed');
  }

  return <section className="shelf-panel suggestions" aria-labelledby="suggestions-title">
    <h2 id="suggestions-title">Waiting for you</h2>
    <p className="fine muted">Found in what you dropped. Nothing is added anywhere until you say so.</p>
    {rows.length === 0 && <p className="fine muted">Nothing waiting. To-dos and events Satchel finds show up here.</p>}
    {rows.length > 0 && <ul>{rows.map(s => <li key={s.id} className="suggestion">
      <div className="what">
        <span className="eyebrow">{s.kind === 'todo' ? 'To-do' : 'Event'}{s.profile ? ` · ${PROFILE_LABEL[s.profile]}` : ''}{whenOf(s) ? ` · ${whenOf(s)}` : ''}</span>
        <strong>{s.title}</strong>
        <span className="fine muted">from “{s.source}”</span>
      </div>
      <div className="row">
        {!s.profile && <><label className="visually-hidden" htmlFor={`where-${s.id}`}>Which profile</label>
          <select id={`where-${s.id}`} className="field compact" value={picked[s.id] ?? ''}
            onChange={event => setPicked(current => ({ ...current, [s.id]: event.target.value as ProfileKind }))}>
            <option value="" disabled>Which profile?</option>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
          </select></>}
        {(() => {
          const where = s.profile ?? picked[s.id];
          if (where && !linkedTo.has(where))
            return <LinkButton small to="/settings" title={`No Google account is linked to ${PROFILE_LABEL[where]} yet`}>Link {PROFILE_LABEL[where]} Google</LinkButton>;
          return <Button small disabled={!where || (act.busy && actingOn === s.id)} onClick={() => where && void add(s, where)}>
            {act.busy && actingOn === s.id ? 'Adding…' : s.kind === 'todo' ? 'Add to Tasks' : 'Add to Calendar'}</Button>;
        })()}
        <Button small look="quiet" disabled={act.busy && actingOn === s.id} onClick={() => void dismiss(s)}>Dismiss</Button>
      </div>
      {act.error && actingOn === s.id && <SaveError title="Could not change this." message={act.error} />}
    </li>)}</ul>}
  </section>;
}
