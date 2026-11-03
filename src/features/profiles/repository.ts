import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';

export type ProfileKind = 'work' | 'personal';
export type Profile = { kind: ProfileKind; timezone: string | null; topics: number };
export const PROFILE_LABEL: Record<ProfileKind, string> = { work: 'Work', personal: 'Personal' };

export function createProfileRepository(db: SupabaseClient) {
  return {
    /** Both profiles, made on first look. */
    async list(): Promise<Profile[]> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('list_profiles').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
    async setTimezone(timezone: string): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('set_profile_timezone', { p_timezone: timezone }).abortSignal(signal));
      if (error) throw error;
    },
    async topicProfiles(): Promise<Record<string, ProfileKind>> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('topic_profile_list').abortSignal(signal));
      if (error) throw error;
      return Object.fromEntries(((data ?? []) as { topic_id: string; kind: ProfileKind }[]).map(row => [row.topic_id, row.kind]));
    },
    async setTopicProfile(topicId: string, kind: ProfileKind | null): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('set_topic_profile', { p_topic_id: topicId, p_kind: kind }).abortSignal(signal));
      if (error) throw error;
    },
  };
}
