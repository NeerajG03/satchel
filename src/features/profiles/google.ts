import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import { callApi } from '../../app/api';
import type { ProfileKind } from './repository';
import type { Suggestion } from '../shelf/repository';

export type GoogleLink = { profile: ProfileKind; email: string; linked_at: string };
const PENDING = 'satchel-google-link';

export function createGoogleRepository(db: SupabaseClient) {
  return {
    async links(): Promise<GoogleLink[]> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('google_link_status').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as GoogleLink[];
    },
    /** Sends the browser to Google's own consent screen. The state comes back and is checked. */
    async start(profile: ProfileKind): Promise<void> {
      const { url, state } = await callApi<{ url: string; state: string }>(db, '/api/google', { action: 'start', profile }, 20000);
      sessionStorage.setItem(PENDING, JSON.stringify({ state, profile }));
      window.location.assign(url);
    },
    /** What Google sent back, checked against what this tab sent, then linked. */
    async finish(params: URLSearchParams): Promise<GoogleLink> {
      const raw = sessionStorage.getItem(PENDING);
      sessionStorage.removeItem(PENDING);
      const pending = raw ? JSON.parse(raw) as { state: string; profile: ProfileKind } : null;
      if (params.get('error')) throw new Error(params.get('error') === 'access_denied'
        ? 'You said no on Google’s screen, so nothing was linked.' : 'Google did not finish linking. Try again.');
      if (!pending || !params.get('code') || params.get('state') !== pending.state)
        throw new Error('This link did not start in this tab, so it was not used. Start again from Settings.');
      return callApi<GoogleLink>(db, '/api/google', { action: 'link', profile: pending.profile, code: params.get('code') }, 30000);
    },
    async unlink(profile: ProfileKind): Promise<void> {
      await callApi(db, '/api/google', { action: 'unlink', profile }, 20000);
    },
    async add(s: Suggestion, profile: ProfileKind): Promise<{ kind: 'task' | 'event'; link: string }> {
      return callApi(db, '/api/google', { action: 'add', id: s.id, profile }, 30000);
    },
  };
}
