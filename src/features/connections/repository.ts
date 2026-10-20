import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';

export type Connection = {
  client_id: string; label: string; personal: boolean; can_write: boolean;
  // A blanket grant keeps no list, so all_topics and topic_ids are never
  // both meaningful. all_topics is the one that decides.
  all_topics: boolean; topic_ids: string[];
  revoked_at: string | null; created_at: string;
};
export type GrantRequest = {
  clientId: string; label: string;
  personal: boolean; allTopics: boolean; topicIds: string[]; canWrite: boolean;
};

const COLUMNS = 'client_id,label,personal,all_topics,topic_ids,can_write,revoked_at,created_at';

export function createConnectionRepository(db: SupabaseClient) {
  return {
    async list(): Promise<Connection[]> {
      const { data, error } = await requestWithTimeout(signal => db.from('agent_connections').select(COLUMNS).order('created_at').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Connection[];
    },
    async grant(request: GrantRequest): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('authorize_agent_v4', {
        p_client_id: request.clientId, p_label: request.label.slice(0, 100) || 'Agent connection',
        p_personal: request.personal, p_all_topics: request.allTopics,
        p_topic_ids: request.topicIds, p_can_write: request.canWrite,
      }).abortSignal(signal));
      if (error) throw error;
    },
    // Satchel's grant is written only once the approval has gone through, so
    // a failed approval leaves nothing on the Apps page. The app cannot use
    // the code until the person is sent back, which happens after this
    // returns, so its first token already carries the grant. If the grant is
    // refused, the approval is taken back and the code is never handed over.
    async approve(authorizationId: string, request: GrantRequest): Promise<{ redirectUrl: string }> {
      const approved = await db.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (approved.error) throw approved.error;
      try {
        await this.grant(request);
      } catch (error) {
        // An approval left standing with no grant behind it is worse than the
        // old bug: the next connect skips this page and the app is refused on
        // every call, with nothing on the Apps page to revoke. So try hard.
        for (let attempt = 0; attempt < 3; attempt++) {
          const undone = await db.auth.oauth.revokeGrant({ clientId: request.clientId }).catch(reason => ({ error: reason }));
          if (!undone.error) break;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
        throw error;
      }
      return { redirectUrl: approved.data.redirect_url };
    },
    async revoke(connection: Pick<Connection, 'client_id'>): Promise<{ oauthCleanupFailed: boolean }> {
      const { error } = await requestWithTimeout(signal => db.rpc('revoke_agent', { p_client_id: connection.client_id }).abortSignal(signal));
      if (error) throw error;
      const { error: oauthError } = await db.auth.oauth.revokeGrant({ clientId: connection.client_id });
      return { oauthCleanupFailed: Boolean(oauthError) };
    },
  };
}
export type ConnectionRepository = ReturnType<typeof createConnectionRepository>;

export function partnerSlug(name: string): 'claude' | 'openai' | 'other' {
  const lower = name.toLowerCase();
  if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
  if (lower.includes('codex') || lower.includes('openai') || lower.includes('chatgpt')) return 'openai';
  return 'other';
}
