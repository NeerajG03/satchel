import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import type { Delivery, KitItem, Release, Skill, SkillSource, Target } from './model';

// Reads go straight to Supabase under row-level security. Writes that need the
// GitHub App go through /api/skills, because its signing key is server-only.
export function createSkillRepository(db: SupabaseClient) {
  async function callApi<T>(body: Record<string, unknown>): Promise<T> {
    const { data } = await db.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw { code: '42501' };
    const response = await requestWithTimeout(async signal => fetch('/api/skills', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }), 30000);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error ?? 'Satchel could not complete that request.');
    return payload as T;
  }

  return {
    async sources(): Promise<SkillSource[]> {
      const { data, error } = await requestWithTimeout(signal => db.from('skill_sources')
        .select('id,repository,commit_sha,is_delivery_target,synced_at').order('repository').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as SkillSource[];
    },
    async skills(): Promise<Skill[]> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('list_skills').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Skill[];
    },
    async kit(): Promise<KitItem[]> {
      const { data, error } = await requestWithTimeout(signal => db.from('skill_kit_items')
        .select('target,skill_id').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as KitItem[];
    },
    async releases(): Promise<Release[]> {
      const { data, error } = await requestWithTimeout(signal => db.from('skill_releases')
        .select('id,target,version,checksum,commit_sha,delivered_at,manifest')
        .not('commit_sha', 'is', null).order('version', { ascending: false }).abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Release[];
    },
    async delivery(): Promise<Delivery | null> {
      const { data, error } = await requestWithTimeout(signal => db.from('skill_delivery')
        .select('repository,installation_id,branch,revoked_at').abortSignal(signal).maybeSingle());
      if (error) throw error;
      return (data ?? null) as Delivery | null;
    },
    async addSource(id: string, repository: string): Promise<SkillSource> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('add_skill_source', {
        p_id: id, p_repository: repository,
      }).abortSignal(signal).single<SkillSource>());
      if (error) throw error;
      if (!data) throw new Error('Missing source');
      return data;
    },
    async setDeliverySource(sourceId: string): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('set_delivery_source', {
        p_source_id: sourceId,
      }).abortSignal(signal));
      if (error) throw error;
    },
    async setKitItem(target: Target, skillId: string, included: boolean): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('set_kit_item', {
        p_target: target, p_skill_id: skillId, p_included: included,
      }).abortSignal(signal));
      if (error) throw error;
    },
    connect: (repository: string, installationId: number) =>
      callApi<{ delivery: { repository: string; branch: string } }>({ action: 'connect', repository, installation_id: installationId }),
    sync: (sourceId: string) =>
      callApi<{ synced: number; empty?: boolean; warnings?: string[] }>({ action: 'sync', source_id: sourceId }),
    // The release id is supplied by the caller and reused across retries, which
    // is the whole point of the idempotency contract in the migration.
    publish: (target: Target, releaseId: string) =>
      callApi<{ release: { version: number; commit_sha: string; checksum: string; removed: string[] }; notes?: string[] }>(
        { action: 'publish', target, release_id: releaseId }),
  };
}
export type SkillRepository = ReturnType<typeof createSkillRepository>;
