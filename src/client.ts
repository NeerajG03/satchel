import { createClient } from '@supabase/supabase-js';
import { errorMessage, needsSessionCheck, type Operation } from './errorText.mjs';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Only the public project key belongs in the browser. RLS enforces data access.
export const client = url && key && !url.includes('your-topic') && key !== 'your-publishable-key'
  ? createClient(url, key, { auth: { flowType: 'pkce', detectSessionInUrl: true } })
  : null;

// The mapping lives in a plain module so node --test can check it.
export { Sentence, errorMessage, type Operation } from './errorText.mjs';

/** Whether this browser still holds a live session, from the auth client
 *  itself. getSession refreshes an expired token first, so no session here
 *  means the refresh failed too. undefined when it cannot be asked. */
export async function stillSignedIn(): Promise<boolean | undefined> {
  if (!client) return undefined;
  try {
    const { data, error } = await client.auth.getSession();
    if (error) return undefined;
    return Boolean(data.session);
  } catch { return undefined; }
}

/** The sentence for a failure. "Sign in again" comes only from the session:
 *  a refusal whose text cannot say whether it was the sign-in is settled by
 *  asking the auth client, never guessed from the error code. */
export async function explain(error: unknown, operation: Operation = 'save'): Promise<string> {
  const signedIn = needsSessionCheck(error) ? await stillSignedIn() : undefined;
  return errorMessage(error, operation, signedIn);
}
