import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Only the public project key belongs in the browser. RLS enforces data access.
export const client = url && key && !url.includes('your-project') && key !== 'your-publishable-key'
  ? createClient(url, key, { auth: { flowType: 'pkce', detectSessionInUrl: true } })
  : null;

export type Project = { id: string; name: string; brief: string };
export type MemorySummary = {
  id: string; project_id: string; name: string; description: string;
  revision: number; updated_at: string;
};
export type Memory = MemorySummary & { more_info: string; created_at: string };

export function errorMessage(error: unknown, operation: 'load' | 'save' = 'save'): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01') return 'This Satchel instance needs its database setup completed. Contact the instance owner, then reload.';
  if (code === '23505') return 'That memory name is already used in this project. Choose a different name.';
  if (code === 'P0002') return 'That memory was renamed, deleted or is no longer accessible. Reload the book.';
  if (code === '40001') return 'This memory changed elsewhere. Reload the book before editing again. Your draft is still here.';
  if (code === '23514') return 'Check the text length and try again.';
  if (code === '42501' || code === 'PGRST301') return 'Your access could not be verified. Sign in again and retry.';
  return operation === 'load'
    ? 'Your book could not be loaded. Check your connection and reload.'
    : 'Satchel could not complete that request. Check your connection and retry. Your draft is still here.';
}
