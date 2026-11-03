import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../request.mjs';
import { Sentence } from '../client';

export const SIGNED_OUT = 'Your sign-in has expired. Sign in again, then try once more.';

/** POSTs to one of Satchel's own endpoints as the signed-in person. An error comes back as a sentence to show. */
export async function callApi<T>(db: SupabaseClient, path: string, body: object, timeout: number): Promise<T> {
  const { data, error } = await db.auth.getSession();
  if (error || !data.session) throw new Sentence(SIGNED_OUT);
  const response = await requestWithTimeout(signal => fetch(path, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session!.access_token}` },
    body: JSON.stringify(body),
  }), timeout);
  // `npm run dev` serves the app and not the endpoints, so this answers with index.html.
  if (!response.headers.get('content-type')?.includes('json'))
    throw new Sentence('This server does not run the endpoints. Use npm run serve, or the deployed app.');
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Sentence(SIGNED_OUT);
  if (!response.ok) throw new Sentence(payload.error ?? `Satchel answered ${response.status}. Reload and try again.`);
  return payload as T;
}
