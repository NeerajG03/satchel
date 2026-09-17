import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { client } from '../client';

type Auth = {
  db: SupabaseClient | null;
  user: User | null;
  ready: boolean;
  busy: boolean;
  error: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
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
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  async function signIn() {
    if (!client) return;
    setBusy(true); setError('');
    try {
      const { error: oauthError } = await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.origin } });
      if (oauthError) throw oauthError;
    } catch { setError('GitHub sign-in is unavailable right now. Nothing was created. Try again in a moment.'); setBusy(false); }
  }
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

  return <AuthContext.Provider value={{ db: client, user, ready, busy, error, signIn, signOut }}>{children}</AuthContext.Provider>;
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
