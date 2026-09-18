import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { client } from '../client';
import { isDesktop } from '../platform';
import { focusDesktopWindow, handleDeepLink, listenForDeepLinks, openDesktopSignIn } from '../desktopAuth';

type Auth = {
  db: SupabaseClient | null;
  user: User | null;
  ready: boolean;
  busy: boolean;
  error: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  cancelSignIn: () => void;
};

const AuthContext = createContext<Auth | null>(null);
const RETURN_KEY = 'satchel-return-to';

export function rememberReturnPath(path: string) {
  try { sessionStorage.setItem(RETURN_KEY, path); } catch { /* Sign-in still works without a return path. */ }
}
export function takeReturnPath(): string | null {
  try {
    const path = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return path && path.startsWith('/') ? path : null;
  } catch { return null; }
}

export function hasOAuthResult() {
  return location.search.includes('code=') || location.search.includes('error') || location.hash.includes('error=');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!client);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client) return;
    const db = client;
    let active = true;
    const cancelled = new URLSearchParams(location.search).has('error') || location.hash.includes('error=');
    client.auth.getSession().then(({ data, error: authError }) => {
      if (!active) return;
      if (authError) setError('GitHub sign-in didn’t finish. It was cancelled or timed out. Nothing was created. Try again, or check that pop-ups are allowed.');
      setUser(data.session?.user ?? null);
      setReady(true);
    }).catch(() => { if (active) { setError('Sign-in is unavailable right now. Try again in a moment.'); setReady(true); } });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (active) { setUser(session?.user ?? null); setReady(true); }
    });
    if (cancelled) setError('GitHub sign-in didn’t finish. It was cancelled or timed out. Nothing was created. Try again, or check that pop-ups are allowed.');
    // The desktop shell receives the OAuth code through a satchel:// link instead of the page URL.
    let unlisten: (() => void) | undefined;
    if (isDesktop) {
      listenForDeepLinks(url => {
        handleDeepLink(db, url).then(outcome => {
          if (!active || outcome.kind === 'ignored') return;
          if (outcome.kind === 'signed-in') { setError(''); void focusDesktopWindow(); }
          else if (outcome.kind === 'cancelled') setError('GitHub sign-in didn’t finish. It was cancelled in the browser. Nothing was created. Try again.');
          else setError(outcome.message);
          setBusy(false);
        });
      }).then(stop => { if (active) unlisten = stop; else stop(); })
        .catch(() => { if (active) setError('This app could not register for sign-in links. Quit and reopen Satchel, then try again.'); });
    }
    return () => { active = false; subscription.unsubscribe(); unlisten?.(); };
  }, []);

  async function signIn() {
    if (!client) return;
    setBusy(true); setError('');
    try {
      if (isDesktop) { await openDesktopSignIn(client); return; }
      const { error: oauthError } = await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.origin } });
      if (oauthError) throw oauthError;
    } catch { setError('GitHub sign-in is unavailable right now. Nothing was created. Try again in a moment.'); setBusy(false); }
  }
  function cancelSignIn() { setBusy(false); }
  async function signOut() {
    if (!client) return;
    setBusy(true); setError('');
    try {
      const { error: outError } = await client.auth.signOut({ scope: 'local' });
      if (outError) throw outError;
      setUser(null);
    } catch { setError('Could not sign out. You are still signed in. Try again.'); }
    finally { setBusy(false); }
  }

  return <AuthContext.Provider value={{ db: client, user, ready, busy, error, signIn, signOut, cancelSignIn }}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth needs AuthProvider');
  return value;
}

export function useDb(): SupabaseClient {
  const { db } = useAuth();
  if (!db) throw new Error('Signed-in pages need a configured client');
  return db;
}
