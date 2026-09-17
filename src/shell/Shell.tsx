import { Outlet, useLocation, useNavigate } from 'react-router';
import { useEffect } from 'react';
import { hasOAuthResult, rememberReturnPath, takeReturnPath, useAuth } from '../app/auth';
import { ReadoutProvider } from '../app/readout';
import { Header } from './Header';
import { Rail } from './Rail';
import { Footer } from './Footer';
import { Welcome } from '../features/leftoff/Welcome';

export function Shell() {
  const { user, ready, db } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname + location.search;
  const signedOut = ready && (!user || !db);
  const signedIn = ready && Boolean(user && db);

  useEffect(() => { if (signedOut && path !== '/') rememberReturnPath(path); }, [signedOut, path]);
  useEffect(() => { if (signedIn && hasOAuthResult()) navigate(takeReturnPath() ?? '/', { replace: true }); }, [signedIn, navigate]);

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
