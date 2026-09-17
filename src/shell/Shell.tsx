import { Outlet, useLocation } from 'react-router';
import { useEffect } from 'react';
import { useAuth, rememberReturnPath } from '../app/auth';
import { ReadoutProvider } from '../app/readout';
import { Header } from './Header';
import { Rail } from './Rail';
import { Footer } from './Footer';
import { Welcome } from '../features/leftoff/Welcome';

export function Shell() {
  const { user, ready, db } = useAuth();
  const location = useLocation();
  const path = location.pathname + location.search;
  const signedOut = ready && (!user || !db);

  useEffect(() => { if (signedOut && path !== '/') rememberReturnPath(path); }, [signedOut, path]);

  return <ReadoutProvider>
    <div className="frame">
      <Header />
      <div className="body">
        {user && db && <Rail />}
        <div className="paper">
          {!ready ? <main><p role="status" className="muted">Opening your Satchel…</p></main>
            : signedOut ? <Welcome />
            : <main><Outlet /></main>}
          <Footer right={signedOut ? 'A little less repeating yourself' : undefined} />
        </div>
      </div>
    </div>
  </ReadoutProvider>;
}
