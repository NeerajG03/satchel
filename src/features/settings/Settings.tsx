import { useAuth } from '../../app/auth';
import { useFooter } from '../../app/readout';
import { accountHandle } from '../../shell/Header';
import { Link } from 'react-router';
import { setDevMode, useDevMode } from '../../app/dev';
import { Button } from '../../ui/Button';
import { CheckField } from '../../ui/Field';
import { Overnight } from './Overnight';
import { ReplyCheck } from './ReplyCheck';

export function Settings() {
  const { user, signOut, busy: authBusy } = useAuth();
  const dev = useDevMode();
  useFooter('Settings');

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
      <Overnight />
      <ReplyCheck />
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
          <p className="muted">Forget removes a record from active retrieval right away. Satchel cannot delete copies from earlier chats or an app’s own memory.</p>
          <a href="https://github.com/neerajg03/satchel/blob/main/docs/product.md" target="_blank" rel="noreferrer" className="fine">Read how retention works ↗</a>
        </div>
      </div>
    </div>
  </>;
}
