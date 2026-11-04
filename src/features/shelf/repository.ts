import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import { Sentence } from '../../client';
import { callApi, SIGNED_OUT } from '../../app/api';
import type { ProfileKind } from '../profiles/repository';

export type ShelfKind = 'note' | 'photo' | 'voice';
export type ShelfItem = {
  id: string; kind: ShelfKind; note: string; object_path: string | null; mime_type: string | null;
  description: string | null; status: 'waiting' | 'reading' | 'ready' | 'failed'; created_at: string;
  profile: ProfileKind | null; transcript?: string | null; sorted_at?: string | null; similarity?: number;
  topic_id?: string | null; topic_name?: string | null; voice_path?: string | null;
};

export type Suggestion = {
  id: string; item_id: string; profile: ProfileKind | null; kind: 'todo' | 'event'; title: string;
  due_date: string | null; starts_at: string | null; ends_at: string | null; source: string; created_at: string;
};

/** When a suggestion happens, as the person reads it. */
export function whenOf(s: Suggestion): string | null {
  const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (s.starts_at) {
    const start = new Date(s.starts_at);
    return `${day(start)}, ${start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  // A date with no time is a calendar day, not an instant: read it at noon so no zone moves it.
  if (s.due_date) return `${s.kind === 'todo' ? 'by ' : ''}${day(new Date(`${s.due_date}T12:00:00`))}`;
  return null;
}

export type Want = {
  id: string; list: string; title: string; detail: string | null; profile: ProfileKind | null;
  status: 'want' | 'done'; created_at: string; done_at: string | null; item_ids: string[];
  // A receipt has its amount as printed (null when it was not) and its day; a fact is a label and a value.
  kind: 'item' | 'expense' | 'fact'; amount: string | number | null; currency: string | null; spent_on: string | null;
};

/** An amount as the person reads it: ₹2,340.00, $23.40, or the bare number when no currency was shown. */
export function moneyOf(w: Want): string {
  if (w.amount == null) return 'amount?';
  const n = Number(w.amount);
  return w.currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency: w.currency }).format(n)
    : new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
/** The lists there are, the biggest first: they are made as drops call for them. */
export function listsOf(wants: Want[]): string[] {
  const sizes = new Map<string, number>();
  for (const w of wants) sizes.set(w.list, (sizes.get(w.list) ?? 0) + 1);
  return [...sizes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

export const SHELF_LIMITS = { note: 4000, bytes: 20 * 1024 * 1024 };
export const UNSUPPORTED_FILE = 'The Shelf takes photos (JPEG, PNG, WebP, HEIC) and voice notes (WebM, M4A, MP3, WAV, OGG).';
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
};
// A recorder says "audio/webm;codecs=opus"; the bucket and the table know the bare type.
export const bareType = (type: string) => type.split(';')[0].trim().toLowerCase();
export const kindOf = (type: string): ShelfKind | null =>
  !(bareType(type) in EXTENSIONS) ? null : bareType(type).startsWith('image/') ? 'photo' : 'voice';


export function createShelfRepository(db: SupabaseClient) {
  async function session() {
    const { data, error } = await db.auth.getSession();
    if (error || !data.session) throw new Sentence(SIGNED_OUT);
    return data.session;
  }
  const server = <T,>(body: object, timeout: number) => callApi<T>(db, '/api/shelf', body, timeout);

  return {
    async list(): Promise<ShelfItem[]> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('list_shelf_items', { p_limit: 100 }).abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as ShelfItem[];
    },
    /** The row first, then the file, then the read. Storage only takes a file
     *  a waiting row already names, so a half-done drop leaves a row that says
     *  so rather than a file nothing knows about. */
    /** A photo may bring a voice note of what it is; it is saved with the photo, as one item. */
    async add({ note, file, voice }: { note: string; file?: Blob | null; voice?: Blob | null }): Promise<ShelfItem> {
      const id = crypto.randomUUID();
      const kind = file ? kindOf(file.type) : 'note';
      if (!kind) throw new Sentence(UNSUPPORTED_FILE);
      if (voice && (kind !== 'photo' || kindOf(voice.type) !== 'voice')) throw new Sentence(UNSUPPORTED_FILE);
      if ([file, voice].some(f => f && f.size > SHELF_LIMITS.bytes)) throw new Sentence('That file is over 20 MB, so nothing was saved. Try a smaller one.');
      const owner = file ? (await session()).user.id : null;
      const type = file ? bareType(file.type) : null;
      const voiceType = voice ? bareType(voice.type) : null;
      const path = file ? `${owner}/${id}.${EXTENSIONS[type!]}` : null;
      const voicePath = voice ? `${owner}/${id}-voice.${EXTENSIONS[voiceType!]}` : null;
      const { data, error } = await requestWithTimeout(signal => db.rpc('add_shelf_item', {
        p_id: id, p_kind: kind, p_note: note.trim(), p_object_path: path, p_mime_type: type, p_size_bytes: file?.size ?? null,
        ...(voice ? { p_voice_path: voicePath, p_voice_mime: voiceType, p_voice_size: voice.size } : {}),
      }).abortSignal(signal).single<ShelfItem>());
      if (error) throw error;
      const uploads: [string | null, Blob | null | undefined, string | null][] = [[path, file, type], [voicePath, voice, voiceType]];
      for (const [where, blob, contentType] of uploads) {
        if (!where || !blob) continue;
        const { error: uploadError } = await db.storage.from('shelf').upload(where, blob, { contentType: contentType!, upsert: false });
        if (uploadError) {
          // Take the row (and any file already up) back out, so nothing is left half there.
          await db.rpc('remove_shelf_item', { p_id: id });
          await db.storage.from('shelf').remove([path, voicePath].filter((p): p is string => Boolean(p)));
          throw new Sentence('The file did not upload, so nothing was saved. Try again.');
        }
      }
      return { ...data!, description: null, profile: null, voice_path: voicePath };
    },
    async describe(id: string): Promise<{ status: ShelfItem['status']; description: string | null;
      profile: ShelfItem['profile']; suggestions: number; transcript: string | null; sorted: boolean; lines?: number }> {
      return server({ action: 'describe', id }, 60000);
    },
    async sort(id: string): Promise<{ profile: ShelfItem['profile']; suggestions: number; transcript: string | null; lines?: number }> {
      return server({ action: 'sort', id }, 60000);
    },
    /** Changes the note; the server makes the new search vector from the new words. */
    async edit(id: string, note: string): Promise<void> {
      await server({ action: 'edit', id, note }, 20000);
    },
    async search(q: string): Promise<ShelfItem[]> {
      return (await server<{ items: ShelfItem[] }>({ action: 'search', q }, 20000)).items;
    },
    /** Links that work for twelve hours, for the files on screen. */
    async fileUrls(paths: string[]): Promise<Record<string, string>> {
      if (!paths.length) return {};
      const { data, error } = await db.storage.from('shelf').createSignedUrls(paths, 12 * 3600);
      if (error) throw error;
      return Object.fromEntries((data ?? []).flatMap(row => row.signedUrl && row.path ? [[row.path, row.signedUrl]] : []));
    },
    async setProfile(item: ShelfItem, profile: ShelfItem['profile']): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('set_shelf_profile', { p_id: item.id, p_kind: profile }).abortSignal(signal));
      if (error) throw error;
    },
    async suggestions(): Promise<Suggestion[]> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('list_shelf_suggestions').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Suggestion[];
    },
    async dismiss(s: Suggestion): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('decide_shelf_suggestion', { p_id: s.id, p_status: 'dismissed' }).abortSignal(signal));
      if (error) throw error;
    },
    async wants(): Promise<Want[]> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('list_shelf_wants').abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as Want[];
    },
    async setWant(id: string, status: Want['status']): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('set_shelf_want', { p_id: id, p_status: status }).abortSignal(signal));
      if (error) throw error;
    },
    async moveWant(id: string, list: string): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('move_shelf_want', { p_id: id, p_list: list }).abortSignal(signal));
      if (error) throw error;
    },
    async removeWant(id: string): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('remove_shelf_want', { p_id: id }).abortSignal(signal));
      if (error) throw error;
    },
    /** Takes back the lines one drop made, unless another drop has them too. */
    async undoWants(itemId: string): Promise<void> {
      const { error } = await requestWithTimeout(signal => db.rpc('undo_shelf_wants', { p_item: itemId }).abortSignal(signal));
      if (error) throw error;
    },
    /** The one-time pass over drops from before lists: a few at a time, quietly. Returns lines added. */
    async listOldDrops(limit = 5): Promise<number> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('shelf_items_for_lists', { p_limit: limit }).abortSignal(signal));
      if (error) throw error;
      let added = 0;
      for (const row of (data ?? []) as { id: string }[])
        added += (await server<{ lines: number }>({ action: 'lists', id: row.id }, 60000).catch(() => ({ lines: 0 }))).lines;
      return added;
    },
    async remove(item: ShelfItem): Promise<void> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('remove_shelf_item', { p_id: item.id }).abortSignal(signal));
      if (error) throw error;
      const row = (data as { object_path: string | null; voice_path?: string | null }[] | null)?.[0];
      const paths = [row?.object_path, row?.voice_path].filter((p): p is string => Boolean(p));
      // The row is gone either way. A file left behind is only reachable by
      // its owner, and is not worth failing the remove over.
      if (paths.length) await db.storage.from('shelf').remove(paths);
    },
  };
}
