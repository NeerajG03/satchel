import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';

export type ProjectRepositoryLink = { provider: 'github'; repository: string };
export type Project = { id: string; name: string; brief: string; revision: number; updated_at: string; created_at: string; project_repositories: ProjectRepositoryLink[] };

export function normalizeGitHubRepository(value: string): string | null {
  const input = value.trim();
  let repository = input;
  const ssh = input.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (ssh) repository = ssh[1];
  else if (/^https?:\/\//i.test(input) || /^ssh:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname.toLowerCase() !== 'github.com') return null;
      repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    } catch { return null; }
  }
  repository = repository.replace(/\.git$/i, '').toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) && repository.length <= 201 ? repository : null;
}

export function createProjectRepository(db: SupabaseClient) {
  return {
    async list(): Promise<Project[]> {
      const { data, error } = await requestWithTimeout(signal => db.from('projects')
        .select('id,name,brief,revision,updated_at,created_at,project_repositories(provider,repository)').order('created_at').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Project[];
    },
    async create(id: string, name: string, brief: string): Promise<Project> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('create_project', {
        p_id: id, p_name: name.trim(), p_brief: brief.trim(),
      }).abortSignal(signal).single<Project>());
      if (error) throw error;
      if (!data) throw new Error('Missing created project');
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
