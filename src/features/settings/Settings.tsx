import { useState } from 'react';
import { useAuth } from '../../app/auth';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count } from '../../app/format';
import { accountHandle } from '../../shell/Header';
import { Link } from 'react-router';
import { setDevMode, useDevMode } from '../../app/dev';
import { Button } from '../../ui/Button';
import { CheckField, SelectField } from '../../ui/Field';
import { SaveError } from '../../ui/Notice';
import { Overnight } from './Overnight';

export function Settings() {
  const { user, signOut, busy: authBusy } = useAuth();
  const stores = useStores();
  const { announce } = useReadout();
  const topics = useLoad(() => stores.topics.list(), [stores]);
  const action = useAction();
  const dev = useDevMode();
  const [pick, setPick] = useState('');
  useFooter('Settings');

  async function exportAll() {
    const total = await action.run(async () => {
      let files = await stores.tasks.exportTopic(null);
      for (const topic of topics.data ?? []) files += await stores.tasks.exportTopic(topic.id);
      return files;
    });
    if (total !== undefined) announce(`Exported ${1 + (topics.data?.length ?? 0)} manifests + ${count(total, 'file')} · no credentials included`);
  }
  async function exportOne() {
    const topic = topics.data?.find(p => p.id === pick);
    const files = await action.run(() => stores.tasks.exportTopic(pick || null));
    if (files !== undefined) announce(`Exported ${topic?.name ?? 'For me'} + ${count(files, 'file')}`);
  }

  return <>
    <div className="head"><div className="col"><span className="eyebrow">Settings</span><h1>Settings.</h1></div></div>
    <div>
      <div className="settings-row">
        <h2>Account</h2>
        <div className="stack-tight">
          <p><strong>{accountHandle(user)}</strong> <span className="muted">· {user?.email}</span></p>
          <p className="fine muted">GitHub is used only to sign you in.</p>
          <Button disabled={authBusy} onClick={() => void signOut()}>Sign out</Button>
        </div>
      </div>
      <div className="settings-row">
        <h2>Take it with you</h2>
        <div className="stack-tight">
          <p className="muted">Export everything as a portable manifest plus your verified task files. No credentials are included. Identifiers, sources and revision history are kept.</p>
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Button look="primary" disabled={action.busy || topics.loading} onClick={() => void exportAll()}>Export all</Button>
            <SelectField label="Export one scope" value={pick} disabled={action.busy} onChange={e => setPick(e.target.value)}>
              <option value="">For me</option>{(topics.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </SelectField>
            <Button disabled={action.busy} onClick={() => void exportOne()}>Export this one</Button>
          </div>
          {action.error && <SaveError message={action.error} />}
        </div>
      </div>
      <Overnight />
      <div className="settings-row">
        <h2>Developer mode</h2>
        <div className="stack-tight">
          <p className="muted">Adds an Activity page showing every request that came in, every
            conversation Satchel kept, and every change to a memory. Read-only. It is a view, not a
            permission: nothing about what is stored or who may read it changes.</p>
          <CheckField label="Show Activity in the rail" hint="this browser only"
            checked={dev} onChange={e => setDevMode(e.target.checked)} />
          {dev && <p className="fine"><Link to="/activity">Open Activity</Link></p>}
        </div>
      </div>
      <div className="settings-row">
        <h2>Forgetting</h2>
        <div className="stack-tight">
          <p className="muted">Forget removes a record from active retrieval right away. Satchel cannot delete copies from earlier chats, exports, or an app’s own memory.</p>
          <a href="https://github.com/neerajg03/satchel/blob/main/docs/product.md" target="_blank" rel="noreferrer" className="fine">Read how retention works ↗</a>
        </div>
      </div>
    </div>
  </>;
}
