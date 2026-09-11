import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';

export type Project = { id: string; name: string; brief: string };

export function createProjectRepository(db: SupabaseClient) {
  return {
    async list(): Promise<Project[]> {
      const { data, error } = await requestWithTimeout(signal => db.from('projects')
        .select('id,name,brief').order('created_at').abortSignal(signal));
      if (error) throw error;
      return data ?? [];
    },
    async create(id: string, name: string, brief: string): Promise<Project> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('create_project', {
        p_id: id, p_name: name.trim(), p_brief: brief.trim(),
      }).abortSignal(signal).single<Project>());
      if (error) throw error;
      if (!data) throw new Error('Missing created project');
      return data;
    },
  };
}
export type ProjectRepository = ReturnType<typeof createProjectRepository>;
