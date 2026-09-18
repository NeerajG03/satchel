import type { SupabaseClient } from '@supabase/supabase-js';
import { desktopAuthCallback, hostedOrigin } from './platform';

// The desktop shell signs in through the user's own browser, where GitHub is already
// signed in, and receives the PKCE code back through the satchel:// URL scheme.

export async function openDesktopSignIn(db: SupabaseClient): Promise<void> {
  const { data, error } = await db.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: desktopAuthCallback, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data.url) throw new Error('No sign-in URL was returned.');
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(data.url);
}

export type DeepLinkOutcome =
  | { kind: 'signed-in' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | { kind: 'ignored' };

// Exchanges an auth callback for a session. Any other satchel:// link is ignored here.
export async function handleDeepLink(db: SupabaseClient, raw: string): Promise<DeepLinkOutcome> {
  let url: URL;
  try { url = new URL(raw); } catch { return { kind: 'ignored' }; }
  if (url.protocol !== 'satchel:') return { kind: 'ignored' };
  // Agent consent must happen on the hosted web app, which owns the OAuth return address.
  if (url.searchParams.has('authorization_id')) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(`${hostedOrigin}/authorize?authorization_id=${encodeURIComponent(url.searchParams.get('authorization_id') ?? '')}`);
    return { kind: 'ignored' };
  }
  if (!raw.startsWith(desktopAuthCallback)) return { kind: 'ignored' };
  if (url.searchParams.has('error')) {
    return url.searchParams.get('error') === 'access_denied'
      ? { kind: 'cancelled' }
      // Fixed sentence on purpose: any local link can carry an error_description, so it is never shown.
      : { kind: 'error', message: 'GitHub sign-in could not be completed. Nothing was created. Try again.' };
  }
  const code = url.searchParams.get('code');
  if (!code) return { kind: 'ignored' };
  const { error } = await db.auth.exchangeCodeForSession(code);
  if (error) return { kind: 'error', message: 'Sign-in could not be completed. Please try again.' };
  return { kind: 'signed-in' };
}

// Listens for links while running and also checks the link that may have launched the app.
export async function listenForDeepLinks(onLink: (url: string) => void): Promise<() => void> {
  const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
  const unlisten = await onOpenUrl(urls => { for (const url of urls) onLink(url); });
  const initial = await getCurrent().catch(() => null);
  if (initial) for (const url of initial) onLink(url);
  return unlisten;
}

export async function focusDesktopWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    await w.unminimize();
    await w.setFocus();
  } catch { /* Focus is a courtesy; the session is already stored. */ }
}
