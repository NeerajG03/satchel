import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { User } from '@supabase/supabase-js';
import { client } from './client';
import { Workspace } from './Workspace';
import { Connections } from './features/connections/Connections';
import './style.css';

function App() {
  const [authorizationId] = useState(() => {
    const value=new URLSearchParams(location.search).get('authorization_id');
    if(value && /^[a-z0-9_-]{1,200}$/i.test(value)) {sessionStorage.setItem('satchel-authorization',value);return value;}
    return sessionStorage.getItem('satchel-authorization')??undefined;
  });
  const [connectionsOpen,setConnectionsOpen]=useState(!!authorizationId);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!client);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('satchel-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* Device preference still works when storage is unavailable. */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('satchel-theme', theme); } catch { /* Theme remains usable for this page. */ }
  }, [theme]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    client.auth.getSession().then(({ data, error: authError }) => {
      if (!active) return;
      if (authError) setError('Sign-in could not be completed. Please try again.');
      setUser(data.session?.user ?? null);
      setReady(true);
      // OAuth callback codes/errors should not linger in the address bar.
      if (location.search.includes('code=') || location.search.includes('error')) history.replaceState(null, '', '/');
    }).catch(() => { if (active) { setError('Sign-in is unavailable. Please try again.'); setReady(true); } });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (active) { setUser(session?.user ?? null); setReady(true); }
    });
    if (new URLSearchParams(location.search).has('error') || location.hash.includes('error=')) {
      setError('GitHub sign-in was cancelled or could not be completed. You can try again.');
      history.replaceState(null, '', '/');
    }
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  async function signIn() {
    if (!client) return;
    setBusy(true); setError('');
    try {
      const { error } = await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.origin } });
      if (error) throw error;
    } catch { setError('GitHub sign-in is unavailable. Please try again.'); setBusy(false); }
  }
  async function signOut() {
    if (!client) return;
    setBusy(true); setError('');
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      setUser(null);
    } catch { setError('Could not sign out. Please try again.'); }
    finally { setBusy(false); }
  }
  return <div className="shell">
    <header><a className="wordmark" href="/">satchel</a><div className="header-actions">
      <button className="quiet" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? 'Dark' : 'Light'} mode</button>
      {user&&!authorizationId&&<button className="quiet" onClick={()=>setConnectionsOpen(!connectionsOpen)}>{connectionsOpen?'Your book':'Connections'}</button>}
      {user && <button className="quiet" disabled={busy} onClick={signOut}>Sign out</button>}
    </div></header>
    <main>
      {error && <p className="notice error" role="alert">{error}</p>}
      {!ready ? <p role="status">Opening your Satchel…</p> : user ? <>
        <div hidden={connectionsOpen}><Workspace key={user.id} db={client!} /></div>
        {connectionsOpen&&<Connections key={user.id} db={client!} authorizationId={authorizationId}/>}
      </> :
        <section className="welcome">
          <div className="eyebrow">YOUR WORK, WITH YOU</div>
          <h1>A place for what<br />you want to remember.</h1>
          <p className="intro">Keep the decisions and details that make a project yours. Start with a note. Come back to it anywhere.</p>
          <button className="primary" disabled={!client || busy} onClick={signIn}>{busy ? 'Opening GitHub…' : 'Continue with GitHub'} <span aria-hidden="true">↗</span></button>
          {!client ? <p className="notice" role="status">This instance is awaiting account setup. Sign-in will be available once it is connected.</p> : <p className="muted fine">Sign in to your own book. Repository access is not requested.</p>}
          <div className="welcome-footer"><span className="rule" /><span className="eyebrow">A LITTLE LESS REPEATING YOURSELF.</span></div>
        </section>}
    </main>
    <footer>Satchel · Private pilot <span>Explicit saves. Yours to revise.</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
