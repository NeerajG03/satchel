import { useState } from 'react';
import { useStores } from '../../app/stores';
import { useAction, type Loaded } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import { PROFILE_LABEL } from '../profiles/repository';
import { whenOf, type Suggestion } from './repository';
import { Button } from '../../ui/Button';
import { SaveError } from '../../ui/Notice';

/**
 * To-dos and events Satchel found in what you dropped, waiting for you.
 * Nothing reaches a calendar or a to-do list until you add it.
 */
export function Suggestions({ loaded }: { loaded: Loaded<Suggestion[]> }) {
  const stores = useStores();
  const { announce } = useReadout();
  const act = useAction('action');
  const [actingOn, setActingOn] = useState<string | null>(null);
  const rows = loaded.data ?? [];
  if (!rows.length) return null;

  async function dismiss(s: Suggestion) {
    setActingOn(s.id);
    const done = await act.run(async () => { await stores.shelf.dismiss(s); return true; });
    if (!done) return;
    loaded.replace(list => list.filter(row => row.id !== s.id));
    announce('Dismissed');
  }

  return <section className="suggestions" aria-labelledby="suggestions-title">
    <h2 id="suggestions-title">Waiting for you</h2>
    <p className="fine muted">Found in what you dropped. Nothing is added anywhere until you say so.</p>
    <ul>{rows.map(s => <li key={s.id} className="suggestion">
      <div className="what">
        <span className="eyebrow">{s.kind === 'todo' ? 'To-do' : 'Event'}{s.profile ? ` · ${PROFILE_LABEL[s.profile]}` : ''}{whenOf(s) ? ` · ${whenOf(s)}` : ''}</span>
        <strong>{s.title}</strong>
        <span className="fine muted">from “{s.source}”</span>
      </div>
      <div className="row">
        <Button small disabled title="Link Google for this profile in Settings first">Add to Google</Button>
        <Button small look="quiet" disabled={act.busy && actingOn === s.id} onClick={() => void dismiss(s)}>Dismiss</Button>
      </div>
      {act.error && actingOn === s.id && <SaveError title="Could not change this." message={act.error} />}
    </li>)}</ul>
  </section>;
}
