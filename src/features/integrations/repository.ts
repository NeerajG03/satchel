import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import { callApi } from '../../app/api';
import type { ProfileKind } from '../profiles/repository';
import type { Suggestion } from '../shelf/repository';

export type Provider = 'google' | 'notion';
export type Slot = 'todo' | 'event';
export type PluginId = 'google_tasks' | 'google_calendar' | 'notion_database';
export type Connection = { id: string; provider: Provider; label: string; linked_at: string };
export type Fill = { type: string; value: string | boolean | string[] };
export type NotionSettings = { data_source_id: string; name?: string; title?: string; date: string | null; defaults: Record<string, Fill> };
export type Destination = { profile: ProfileKind; slot: Slot; plugin: PluginId; connection_id: string; provider: Provider; label: string;
  settings: Partial<NotionSettings> };
export type Column = { name: string; type: string; options?: string[] };
export type Schema = { id: string; name: string; columns: Column[] };
export type Upcoming = { profile: ProfileKind; kind: 'event' | 'task'; title: string; at: string | null; day: string | null; link: string | null };
export type Week = { items: Upcoming[]; failed: ProfileKind[]; linked: ProfileKind[] };

export const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google', notion: 'Notion' };
export const SLOT_LABEL: Record<Slot, string> = { todo: 'To-dos', event: 'Calendar' };
/** What each plugin can hold, in the order the picker shows them. */
export const PLUGINS: { id: PluginId; provider: Provider; label: string; slots: Slot[] }[] = [
  { id: 'google_tasks', provider: 'google', label: 'Google Tasks', slots: ['todo'] },
  { id: 'google_calendar', provider: 'google', label: 'Google Calendar', slots: ['event', 'todo'] },
  { id: 'notion_database', provider: 'notion', label: 'Notion', slots: ['todo', 'event'] },
];
/** How a slot reads on a button: the Notion database's own name when there is one. */
export const placeName = (d: Destination) =>
  d.plugin === 'notion_database' ? d.settings.name ?? 'Notion' : PLUGINS.find(p => p.id === d.plugin)!.label;

const PENDING = 'satchel-connect';
const API = '/api/integrations';

export function createIntegrationsRepository(db: SupabaseClient) {
  async function rpc<T>(name: string): Promise<T[]> {
    const { data, error } = await requestWithTimeout(signal => db.rpc(name).abortSignal(signal));
    if (error) throw error;
    return (data ?? []) as T[];
  }
  return {
    connections: () => rpc<Connection>('list_connections'),
    destinations: () => rpc<Destination>('list_destinations'),
    /** Sends the browser to the provider's own consent screen. The state comes back and is checked. */
    async start(provider: Provider): Promise<void> {
      const { url, state, verifier } = await callApi<{ url: string; state: string; verifier: string | null }>(db, API, { action: 'start', provider }, 20000);
      sessionStorage.setItem(PENDING, JSON.stringify({ state, provider, verifier }));
      window.location.assign(url);
    },
    /** What the provider sent back, checked against what this tab sent, then connected. */
    async finish(provider: Provider, params: URLSearchParams): Promise<Connection> {
      const raw = sessionStorage.getItem(PENDING);
      sessionStorage.removeItem(PENDING);
      const pending = raw ? JSON.parse(raw) as { state: string; provider: Provider; verifier: string | null } : null;
      const name = PROVIDER_LABEL[provider];
      if (params.get('error')) throw new Error(params.get('error') === 'access_denied'
        ? `You said no on ${name}’s screen, so nothing was connected.` : `${name} did not finish connecting. Try again.`);
      if (!pending || pending.provider !== provider || !params.get('code') || params.get('state') !== pending.state)
        throw new Error('This did not start in this tab, so it was not used. Start again from Settings.');
      return callApi<Connection>(db, API, { action: 'link', provider, code: params.get('code'), verifier: pending.verifier }, 30000);
    },
    async disconnect(id: string): Promise<void> {
      await callApi(db, API, { action: 'unlink', id }, 20000);
    },
    async sources(id: string): Promise<{ id: string; name: string }[]> {
      return (await callApi<{ sources: { id: string; name: string }[] }>(db, API, { action: 'sources', id }, 20000)).sources;
    },
    schema: (id: string, source: string) => callApi<Schema>(db, API, { action: 'schema', id, source }, 20000),
    async setSlot(profile: ProfileKind, slot: Slot, plugin: PluginId | null, connection?: string, settings?: Partial<NotionSettings>): Promise<void> {
      await callApi(db, API, { action: 'set', profile, slot, plugin, connection, settings }, 20000);
    },
    /** The next seven days from every calendar and list that can be read. */
    upcoming: () => callApi<Week>(db, API, { action: 'upcoming' }, 30000),
    add: (s: Suggestion, profile: ProfileKind) =>
      callApi<{ plugin: PluginId; link: string }>(db, API, { action: 'add', id: s.id, profile }, 30000),
  };
}
