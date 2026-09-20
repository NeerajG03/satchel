import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import { scopeProjectId, type Memory, type MemorySummary, type MemoryScope, type MemoryContent } from './model';

export function createMemoryRepository(db: SupabaseClient) {
  return {
    async list(scope: MemoryScope): Promise<MemorySummary[]> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('list_memories', {
        p_project_id: scopeProjectId(scope),
      }).abortSignal(signal));
      if (error) throw error;
      return data ?? [];
    },
    // Across every scope the row policies allow. Its own routine rather than a
    // select, because the index carries a flag and never the detail: reading
    // more_info here would pull up to 40,000 characters a row into the browser
    // just to decide whether a row expands.
    async listAll(): Promise<MemorySummary[]> {
      const { data, error } = await requestWithTimeout(signal =>
        db.rpc('all_memories').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as MemorySummary[];
    },
    // Read by id. A name is an optional handle now, so it was never a key, and
    // the list already carries every statement in full.
    async read(memory: MemorySummary): Promise<Memory> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('read_memory', {
        p_project_id: memory.project_id, p_id: memory.id,
      }).abortSignal(signal).single<Memory>());
      if (error) throw error;
      if (!data) throw { code: 'P0002' };
      return data;
    },
    async save(scope: MemoryScope, id: string, content: MemoryContent): Promise<Memory> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('save_memory', {
        p_id: id, p_project_id: scopeProjectId(scope), p_statement: content.statement.trim(),
        // Written here, so the source is the user's own typing.
        p_source: content.statement.trim(), p_band: 'said', p_task_id: null,
        p_name: content.name.trim() || null, p_more_info: content.more_info,
      }).abortSignal(signal).single<Memory>());
      if (error) throw error;
      if (!data) throw new Error('Missing saved memory');
      return data;
    },
    async correct(memory: MemorySummary, content: MemoryContent): Promise<Memory> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('correct_memory', {
        p_id: memory.id, p_revision: memory.revision, p_statement: content.statement.trim(),
        p_name: content.name.trim() || null, p_more_info: content.more_info,
      }).abortSignal(signal).single<Memory>());
      if (error) throw error;
      if (!data) throw new Error('Missing corrected memory');
      return data;
    },
    // Confirming is the whole promotion rule: the user agrees, and it stops
    // being announced before use.
    async confirm(memory: MemorySummary): Promise<Memory> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('confirm_memory', {
        p_id: memory.id, p_revision: memory.revision,
      }).abortSignal(signal).single<Memory>());
      if (error) throw error;
      if (!data) throw new Error('Missing confirmed memory');
      return data;
    },
    async remove(memory: MemorySummary): Promise<void> {
      const { data, error } = await requestWithTimeout(signal => db.from('memories').delete()
        .eq('id', memory.id).eq('revision', memory.revision).select('id').abortSignal(signal));
      if (error) throw error;
      if (!data?.length) throw { code: 'PT409' };
    },
  };
}
export type MemoryRepository = ReturnType<typeof createMemoryRepository>;
