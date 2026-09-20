import { useState } from 'react';
import { useAuth } from '../../app/auth';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count } from '../../app/format';
import { accountHandle } from '../../shell/Header';
import { Button } from '../../ui/Button';
import { SelectField } from '../../ui/Field';
import { SaveError } from '../../ui/Notice';

export function Settings() {
  const { user, signOut, busy: authBusy } = useAuth();
  const stores = useStores();
  const { announce } = useReadout();
  const projects = useLoad(() => stores.projects.list(), [stores]);
  const action = useAction();
  const [pick, setPick] = useState('');
  useFooter('Settings');

  async function exportAll() {
    const total = await action.run(async () => {
      let files = await stores.tasks.exportProject(null);
      for (const project of projects.data ?? []) files += await stores.tasks.exportProject(project.id);
      return files;
    });
    if (total !== undefined) announce(`Exported ${1 + (projects.data?.length ?? 0)} manifests + ${count(total, 'file')} · no credentials included`);
  }
  async function exportOne() {
    const project = projects.data?.find(p => p.id === pick);
    const files = await action.run(() => stores.tasks.exportProject(pick || null));
    if (files !== undefined) announce(`Exported ${project?.name ?? 'For me'} + ${count(files, 'file')}`);
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
            <Button look="primary" disabled={action.busy || projects.loading} onClick={() => void exportAll()}>Export all</Button>
            <SelectField label="Export one scope" value={pick} disabled={action.busy} onChange={e => setPick(e.target.value)}>
              <option value="">For me</option>{(projects.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </SelectField>
            <Button disabled={action.busy} onClick={() => void exportOne()}>Export this one</Button>
          </div>
          {action.error && <SaveError message={action.error} />}
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
