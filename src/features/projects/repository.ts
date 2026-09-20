import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';

export type ProjectRepositoryLink = { provider: 'github'; repository: string };
export type Project = { id: string; slug: string; name: string; brief: string; revision: number; updated_at: string; created_at: string; project_repositories: ProjectRepositoryLink[] };

import { normalizeGitHubRepository } from './githubRepository';
export { normalizeGitHubRepository };

export function createProjectRepository(db: SupabaseClient) {
  return {
    async list(): Promise<Project[]> {
      const { data, error } = await requestWithTimeout(signal => db.from('projects')
        .select('id,slug,name,brief,revision,updated_at,created_at,project_repositories(provider,repository)').order('created_at').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Project[];
    },
    async create(id: string, name: string, brief: string, slug: string): Promise<Project> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('create_project', {
        p_id: id, p_name: name.trim(), p_brief: brief.trim(),
      }).abortSignal(signal).single<Project>());
      if (error) throw error;
      if (!data) throw new Error('Missing created project');
      // The project always gets a slug. This only replaces the derived one with
      // something the person would actually say, and a collision is reported
      // rather than silently accepted.
      const chosen = slug.trim();
      if (chosen && chosen !== data.slug) {
        const { error: slugError } = await requestWithTimeout(signal => db.rpc('set_slug', {
          p_kind: 'project', p_id: id, p_slug: chosen,
        }).abortSignal(signal));
        if (slugError) throw slugError;
        return { ...data, slug: chosen, project_repositories: [] };
      }
      return { ...data, project_repositories: [] };
    },
    async update(project: Project, name: string, brief: string): Promise<Project> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('upsert_project', {
        p_request_id: crypto.randomUUID(), p_project_id: project.id, p_expected_revision: project.revision,
        p_name: name.trim(), p_brief: brief.trim(),
      }).abortSignal(signal).single<{ project: Project; repositories: ProjectRepositoryLink[] }>());
      if (error) throw error;
      if (!data) throw new Error('Missing updated project');
      return { ...data.project, project_repositories: data.repositories };
    },
    async remove(project: Project): Promise<{ id: string; name: string; memories_removed: number; tasks_removed: number; files_removed: number }> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('delete_project', {
        p_id: project.id, p_expected_revision: project.revision,
      }).abortSignal(signal).single<{ id: string; name: string; memories_removed: number; tasks_removed: number; files_removed: number }>());
      if (error) throw error;
      if (!data) throw new Error('Missing delete result');
      return data;
    },
    async linkRepository(projectId: string, value: string): Promise<ProjectRepositoryLink> {
      const repository = normalizeGitHubRepository(value);
      if (!repository) throw new Error('Enter a GitHub repository as owner/name or a GitHub URL.');
      const { data, error } = await requestWithTimeout(signal => db.rpc('link_project_repository', {
        p_project_id: projectId, p_provider: 'github', p_repository: repository,
      }).abortSignal(signal).single<ProjectRepositoryLink>());
      if (error) throw error;
      if (!data) throw new Error('Missing repository link');
      return { provider: 'github', repository: data.repository };
    },
    async unlinkRepository(projectId: string, link: ProjectRepositoryLink): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('unlink_project_repository', {
        p_project_id: projectId, p_provider: link.provider, p_repository: link.repository,
      }).abortSignal(signal));
      if (error) throw error;
    },
  };
}
export type ProjectRepository = ReturnType<typeof createProjectRepository>;
