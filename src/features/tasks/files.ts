import type { SupabaseClient } from '@supabase/supabase-js';

// The rows are already gone when this runs, so a failure here cannot be
// undone or retried from the page. It leaves a file nothing points at, which
// is worth a warning but not worth telling the person the delete failed.
export async function removeTaskFiles(db: SupabaseClient, keys: string[] | undefined): Promise<void> {
  if (!keys?.length) return;
  for (let start = 0; start < keys.length; start += 1000) {
    const { error } = await db.storage.from('task-files').remove(keys.slice(start, start + 1000));
    if (error) console.warn('Task files were left in storage after the delete', error.message);
  }
}
