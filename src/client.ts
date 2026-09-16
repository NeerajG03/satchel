import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Only the public project key belongs in the browser. RLS enforces data access.
export const client = url && key && !url.includes('your-project') && key !== 'your-publishable-key'
  ? createClient(url, key, { auth: { flowType: 'pkce', detectSessionInUrl: true } })
  : null;

export function errorMessage(error: unknown, operation: 'load' | 'save' = 'save'): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code === 'SATCHEL_TIMEOUT') return operation === 'load'
    ? 'Loading took too long. Reload to try again.'
    : 'The request took too long. Your draft is still here. Reload to check whether the change reached your book before retrying.';
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01') return 'This Satchel instance needs its database setup completed. Contact the instance owner, then reload.';
  if (code === '23505') return 'That memory name is already used in this scope. Choose a different name.';
  if (code === 'P0002') return 'That memory was renamed, deleted or is no longer accessible. Reload the book.';
  if (code === 'PT409' || code === '40001') return 'This record changed elsewhere or conflicts with an earlier save. Reload to see the latest version. Your draft is still here; discard it before starting a fresh correction.';
  if (code === '23514') return 'Check the text length and try again.';
  if (code === '42501' || code === 'PGRST301') return 'Your access could not be verified. Sign in again and retry.';
  if (error instanceof Error && (error.message.startsWith('Files are limited') || error.message.startsWith('The uploaded file did not pass')))
    return error.message;
  return operation === 'load'
    ? 'Your book could not be loaded. Check your connection and reload.'
    : 'Satchel could not complete that request. Check your connection and retry. Your draft is still here.';
}
