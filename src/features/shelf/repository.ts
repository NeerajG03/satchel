import type { SupabaseClient } from '@supabase/supabase-js';
import { requestWithTimeout } from '../../request.mjs';
import { Sentence } from '../../client';
import type { ProfileKind } from '../profiles/repository';

export type ShelfKind = 'note' | 'photo' | 'voice';
export type ShelfItem = {
  id: string; kind: ShelfKind; note: string; object_path: string | null; mime_type: string | null;
  description: string | null; status: 'waiting' | 'reading' | 'ready' | 'failed'; created_at: string;
  profile: ProfileKind | null; similarity?: number;
};

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

const SIGNED_OUT = 'Your sign-in has expired. Sign in again, then try once more.';

export function createShelfRepository(db: SupabaseClient) {
  async function session() {
    const { data, error } = await db.auth.getSession();
    if (error || !data.session) throw new Sentence(SIGNED_OUT);
    return data.session;
  }
  async function server<T>(body: object, timeout: number): Promise<T> {
    const { access_token } = await session();
    const response = await requestWithTimeout(signal => fetch('/api/shelf', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
      body: JSON.stringify(body),
    }), timeout);
    // `npm run dev` serves the app and not the endpoints, so this answers with index.html.
    if (!response.headers.get('content-type')?.includes('json'))
      throw new Sentence('This server does not run the endpoints. Use npm run serve, or the deployed app.');
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Sentence(SIGNED_OUT);
    if (!response.ok) throw new Sentence(payload.error ?? `Satchel answered ${response.status}. Reload and try again.`);
    return payload as T;
  }

  return {
    async list(): Promise<ShelfItem[]> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('list_shelf_items', { p_limit: 100 }).abortSignal(signal));
      if (error) throw error;
      return (data ?? []) as ShelfItem[];
    },
    /** The row first, then the file, then the read. Storage only takes a file
     *  a waiting row already names, so a half-done drop leaves a row that says
     *  so rather than a file nothing knows about. */
    async add({ note, file }: { note: string; file?: Blob | null }): Promise<ShelfItem> {
      const id = crypto.randomUUID();
      const kind = file ? kindOf(file.type) : 'note';
      if (!kind) throw new Sentence(UNSUPPORTED_FILE);
      if (file && file.size > SHELF_LIMITS.bytes) throw new Sentence('That file is over 20 MB, so nothing was saved. Try a smaller one.');
      const type = file ? bareType(file.type) : null;
      const path = file ? `${(await session()).user.id}/${id}.${EXTENSIONS[type!]}` : null;
      const { data, error } = await requestWithTimeout(signal => db.rpc('add_shelf_item', {
        p_id: id, p_kind: kind, p_note: note.trim(), p_object_path: path, p_mime_type: type, p_size_bytes: file?.size ?? null,
      }).abortSignal(signal).single<ShelfItem>());
      if (error) throw error;
      if (file && path) {
        const { error: uploadError } = await db.storage.from('shelf').upload(path, file, { contentType: type!, upsert: false });
        if (uploadError) {
          // Take the row back out, so nothing is left that names a file that never arrived.
          await db.rpc('remove_shelf_item', { p_id: id });
          throw new Sentence('The file did not upload, so nothing was saved. Try again.');
        }
      }
      return { ...data!, description: null, profile: null };
    },
    async describe(id: string): Promise<{ status: ShelfItem['status']; description: string | null }> {
      return server({ action: 'describe', id }, 60000);
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
    async remove(item: ShelfItem): Promise<void> {
      const { data, error } = await requestWithTimeout(signal => db.rpc('remove_shelf_item', { p_id: item.id }).abortSignal(signal));
      if (error) throw error;
      const path = (data as { object_path: string | null }[] | null)?.[0]?.object_path;
      // The row is gone either way. A file left behind is only reachable by
      // its owner, and is not worth failing the remove over.
      if (path) await db.storage.from('shelf').remove([path]);
    },
  };
}
