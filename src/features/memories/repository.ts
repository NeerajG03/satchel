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
    async read(memory: MemorySummary): Promise<Memory> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('read_memory', {
        p_project_id: memory.project_id, p_name: memory.name,
      }).abortSignal(signal).single<Memory>());
      if (error) throw error;
      // A renamed handle reused by another record must never open the wrong ID.
      if (!data || data.id !== memory.id) throw { code: 'P0002' };
      return data;
    },
    async save(scope: MemoryScope, id: string, content: MemoryContent): Promise<Memory> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('save_memory', {
        p_id: id, p_project_id: scopeProjectId(scope), p_name: content.name.trim(),
        p_description: content.description.trim(), p_more_info: content.more_info,
      }).abortSignal(signal).single<Memory>());
      if (error) throw error;
      if (!data) throw new Error('Missing saved memory');
      return data;
    },
    async correct(memory: MemorySummary, content: MemoryContent): Promise<Memory> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('correct_memory', {
        p_id: memory.id, p_revision: memory.revision, p_name: content.name.trim(),
        p_description: content.description.trim(), p_more_info: content.more_info,
      }).abortSignal(signal).single<Memory>());
      if (error) throw error;
      if (!data) throw new Error('Missing corrected memory');
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
