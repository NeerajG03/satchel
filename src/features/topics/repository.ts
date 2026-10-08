import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';

export type TopicRepositoryLink = { provider: 'github'; repository: string };
export type Topic = { id: string; slug: string; name: string; brief: string; revision: number; updated_at: string; created_at: string;
  made_by?: 'person' | 'satchel'; merged_into?: string | null; topic_repositories: TopicRepositoryLink[] };

import { normalizeGitHubRepository } from './githubRepository';
export { normalizeGitHubRepository };

export function createTopicRepository(db: SupabaseClient) {
  return {
    async list(): Promise<Topic[]> {
      const { data, error } = await requestWithTimeout(signal => db.from('topics')
        .select('id,slug,name,brief,revision,updated_at,created_at,made_by,merged_into,topic_repositories(provider,repository)').order('created_at').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Topic[];
    },
    async create(id: string, name: string, brief: string, slug: string): Promise<Topic> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('create_topic', {
        p_id: id, p_name: name.trim(), p_brief: brief.trim(),
      }).abortSignal(signal).single<Topic>());
      if (error) throw error;
      if (!data) throw new Error('Missing created topic');
      // The topic always gets a slug. This only replaces the derived one with
      // something the person would actually say, and a collision is reported
      // rather than silently accepted.
      const chosen = slug.trim();
      if (chosen && chosen !== data.slug) {
        const { error: slugError } = await requestWithTimeout(signal => db.rpc('set_slug', {
          p_kind: 'topic', p_id: id, p_slug: chosen,
        }).abortSignal(signal));
        if (slugError) throw slugError;
        return { ...data, slug: chosen, topic_repositories: [] };
      }
      return { ...data, topic_repositories: [] };
    },
    async update(topic: Topic, name: string, brief: string): Promise<Topic> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('upsert_topic', {
        p_request_id: crypto.randomUUID(), p_topic_id: topic.id, p_expected_revision: topic.revision,
        p_name: name.trim(), p_brief: brief.trim(),
      }).abortSignal(signal).single<{ topic: Topic; repositories: TopicRepositoryLink[] }>());
      if (error) throw error;
      if (!data) throw new Error('Missing updated topic');
      return { ...data.topic, topic_repositories: data.repositories };
    },
    // Puts back exactly the memories the merge moved, and shows the topic again.
    async unmerge(topic: Topic): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('unmerge_topic', { p_from: topic.id }).abortSignal(signal));
      if (error) throw error;
    },
    async remove(topic: Topic): Promise<{ id: string; name: string; memories_removed: number; tasks_removed: number; files_removed: number }> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('delete_topic', {
        p_id: topic.id, p_expected_revision: topic.revision,
      }).abortSignal(signal).single<{ id: string; name: string; memories_removed: number; tasks_removed: number; files_removed: number }>());
      if (error) throw error;
      if (!data) throw new Error('Missing delete result');
      return data;
    },
    async linkRepository(topicId: string, value: string): Promise<TopicRepositoryLink> {
      const repository = normalizeGitHubRepository(value);
      if (!repository) throw new Error('Enter a GitHub repository as owner/name or a GitHub URL.');
      const { data, error } = await requestWithTimeout(signal => db.rpc('link_topic_repository', {
        p_topic_id: topicId, p_provider: 'github', p_repository: repository,
      }).abortSignal(signal).single<TopicRepositoryLink>());
      if (error) throw error;
      if (!data) throw new Error('Missing repository link');
      return { provider: 'github', repository: data.repository };
    },
    async unlinkRepository(topicId: string, link: TopicRepositoryLink): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('unlink_topic_repository', {
        p_topic_id: topicId, p_provider: link.provider, p_repository: link.repository,
      }).abortSignal(signal));
      if (error) throw error;
    },
  };
}
export type TopicRepository = ReturnType<typeof createTopicRepository>;
