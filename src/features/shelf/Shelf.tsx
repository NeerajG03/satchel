import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { explain } from '../../client';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count } from '../../app/format';
import { PROFILE_LABEL, type ProfileKind } from '../profiles/repository';
import { kindOf, SHELF_LIMITS, UNSUPPORTED_FILE, type ShelfItem, type ShelfKind } from './repository';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { TextArea, TextField } from '../../ui/Field';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';
import { Segments } from '../../ui/Segments';
import { Suggestions } from './Suggestions';
import { ComingUp } from './ComingUp';

const KIND_LABEL = { note: 'note', photo: 'photo', voice: 'voice note' } as const;
const TYPES: { key: ShelfKind | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' }, { key: 'photo', label: 'Photos' }, { key: 'voice', label: 'Voice notes' }, { key: 'note', label: 'Notes' }];
type ProfileView = ProfileKind | 'all';
const asProfile = (v: string | null): ProfileView => v === 'work' || v === 'personal' ? v : 'all';
const asType = (v: string | null): ShelfKind | 'all' => v === 'photo' || v === 'voice' || v === 'note' ? v : 'all';

/** Items grouped into their topic's section, the biggest first, with "Not sorted yet" last. */
function sectionsOf(rows: ShelfItem[]): { key: string; name: string; items: ShelfItem[] }[] {
  const groups = new Map<string, { key: string; name: string; items: ShelfItem[] }>();
  for (const row of rows) {
    const key = row.topic_id ?? 'none';
    if (!groups.has(key)) groups.set(key, { key, name: row.topic_name ?? 'Not in a topic yet', items: [] });
    groups.get(key)!.items.push(row);
  }
  return [...groups.values()].sort((a, b) => (a.key === 'none' ? 1 : 0) - (b.key === 'none' ? 1 : 0) || b.items.length - a.items.length);
}
// A read that has not come back by now was lost (a closed tab, a dropped
// request), so the item offers a retry instead of saying "reading it…" forever.
const LOST_AFTER_MS = 2 * 60 * 1000;

/** A voice note from the microphone, held until it is saved or thrown away. */
function useRecorder() {
  const recorder = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);
  const [clip, setClip] = useState<Blob | null>(null);
  const [error, setError] = useState('');
  async function start() {
    if (starting || recording) return;
    setError(''); setClip(null); setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The page may have closed while the permission prompt was open.
      if (!alive.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const chunks: Blob[] = [];
      const next = new MediaRecorder(stream);
      next.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      next.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        setClip(new Blob(chunks, { type: next.mimeType || 'audio/webm' }));
        setRecording(false);
      };
      next.start(); recorder.current = next; setRecording(true);
    } catch { setError('Satchel could not use the microphone. Allow it for this site, then try again.'); }
    finally { if (alive.current) setStarting(false); }
  }
  const stop = () => recorder.current?.state === 'recording' && recorder.current.stop();
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (recorder.current?.state === 'recording') recorder.current.stop(); };
  }, []);
  return { recording, starting, clip, error, start, stop, clear: () => setClip(null) };
}

export function Shelf() {
  const stores = useStores();
  const { announce } = useReadout();
  const items = useLoad(() => stores.shelf.list(), [stores]);
  const suggestions = useLoad(() => stores.shelf.suggestions(), [stores]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  // File links last twelve hours; a page open longer than that starts over.
  const signedAt = useRef(Date.now());
  if (Date.now() - signedAt.current > 11 * 3600 * 1000) { signedAt.current = Date.now(); setUrls({}); }
  // Ticks only while something is unread, so a lost read gets its retry
  // without a reload, and a fully read Shelf never re-renders on a timer.
  const [now, setNow] = useState(() => Date.now());
  const unread = (items.data ?? []).some(row => row.status !== 'ready');
  useEffect(() => {
    if (!unread) return;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [unread]);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRecorder();
  const save = useAction('save');
  const act = useAction('action');
  // Which item the last change or remove was for, so its error shows under it.
  const [failedOn, setFailedOn] = useState<string | null>(null);
  // Per item, so a slow read never locks the buttons on every other item.
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ShelfItem[] | null>(null);
  const search = useAction('action');
  const [params, setParams] = useSearchParams();
  const profile = asProfile(params.get('profile'));
  const type = asType(params.get('type'));
  const view = (key: 'profile' | 'type', value: string) => setParams(current => {
    const next = new URLSearchParams(current);
    if (value === 'all') next.delete(key); else next.set(key, value);
    return next;
  }, { replace: true });
  // Null until the person opens or closes it: then an empty Shelf opens it on its own.
  const [dropping, setDropping] = useState<boolean | null>(null);

  const rows = found ?? items.data ?? [];
  const attachment: Blob | null = file ?? recorder.clip;
  const canSave = !save.busy && !recorder.recording && (note.trim().length > 0 || attachment !== null);
  useFooter(items.data ? count(items.data.length, 'thing', 'things') + ' on your Shelf' : '');

  const paths = rows.map(row => row.object_path).filter((path): path is string => Boolean(path) && !urls[path!]);
  useEffect(() => {
    if (!paths.length) return;
    stores.shelf.fileUrls(paths).then(more => setUrls(current => ({ ...current, ...more }))).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join('|'), stores]);

  async function read(item: ShelfItem) {
    setReading(ids => new Set(ids).add(item.id));
    setReadErrors(({ [item.id]: _, ...rest }) => rest);
    let result: Awaited<ReturnType<typeof stores.shelf.describe>> | null = null;
    try { result = await stores.shelf.describe(item.id); }
    catch (reason) { const text = await explain(reason, 'action'); setReadErrors(errors => ({ ...errors, [item.id]: text })); }
    setReading(ids => { const next = new Set(ids); next.delete(item.id); return next; });
    // A refused read says nothing certain about the item: another tab may have
    // finished it. Ask the server what it is rather than guess "failed".
    if (!result) { items.reload(); return; }
    patch(list => list.map(row => row.id === item.id
      ? { ...row, status: result.status, description: result.description ?? row.description,
          transcript: result.transcript ?? row.transcript, sorted_at: result.sorted ? new Date().toISOString() : row.sorted_at } : row));
    if (result.suggestions) suggestions.reload();
    if (result.profile) patch(list => list.map(row => row.id === item.id && !row.profile ? { ...row, profile: result.profile } : row));
    if (result.status === 'ready') announce(item.kind === 'note' ? 'On your Shelf' : 'Read and on your Shelf');
  }
  /** The full list and the search results show the same items; change both. */
  function patch(change: (list: ShelfItem[]) => ShelfItem[]) {
    items.replace(change);
    setFound(list => list && change(list));
  }
  function statusOf(item: ShelfItem): { label: string | false; retry: boolean } {
    if (item.status === 'ready') return { label: false, retry: false };
    if (item.status === 'failed') return { label: 'could not read this one', retry: !reading.has(item.id) };
    const lost = !reading.has(item.id) && now - Date.parse(item.created_at) > LOST_AFTER_MS;
    return { label: lost ? 'not read yet' : 'reading it…', retry: lost };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    const added = await save.run(() => stores.shelf.add({ note, file: attachment }));
    if (!added) return;
    items.replace(list => [added, ...list]);
    setDropping(true);
    setNote(''); setFile(null); recorder.clear();
    if (fileInput.current) fileInput.current.value = '';
    setFound(null); setQuery('');
    form.current?.querySelector('textarea')?.focus();
    void read(added);
  }

  async function find(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) { setFound(null); return; }
    const result = await search.run(() => stores.shelf.search(query));
    if (result) setFound(result);
  }

  async function sortNow(item: ShelfItem) {
    setFailedOn(item.id);
    const result = await act.run(() => stores.shelf.sort(item.id));
    if (!result) return;
    patch(list => list.map(row => row.id === item.id ? { ...row, sorted_at: new Date().toISOString(),
      profile: row.profile ?? result.profile, transcript: result.transcript ?? row.transcript } : row));
    if (result.suggestions) suggestions.reload();
    announce(result.suggestions ? `Found ${count(result.suggestions, 'thing', 'things')} to do` : 'Nothing to do in this one');
  }

  async function moveTo(item: ShelfItem, profile: ShelfItem['profile']) {
    setFailedOn(item.id);
    const done = await act.run(async () => { await stores.shelf.setProfile(item, profile); return true; });
    if (!done) return;
    patch(list => list.map(row => row.id === item.id ? { ...row, profile } : row));
    announce(profile ? `Moved to ${PROFILE_LABEL[profile]}` : 'Taken out of both profiles');
  }

  async function remove(item: ShelfItem) {
    setFailedOn(item.id);
    const done = await act.run(async () => { await stores.shelf.remove(item); return true; });
    if (!done) return;
    patch(list => list.filter(row => row.id !== item.id));
    // Its suggestions went with it in the database; take them off the card too.
    suggestions.replace(list => list.filter(s => s.item_id !== item.id));
    setRemoving(null);
    searchBox.current?.focus();
    announce('Removed from your Shelf');
  }

  function pick(chosen: File | null) {
    save.clear();
    const fits = !chosen || Boolean(kindOf(chosen.type));
    setFileError(fits ? '' : UNSUPPORTED_FILE);
    setFile(fits ? chosen : null); recorder.clear();
    if (!fits && fileInput.current) fileInput.current.value = '';
  }

  const inView = (row: ShelfItem) => (profile === 'all' || !row.profile || row.profile === profile) && (type === 'all' || row.kind === type);
  // Search covers the whole Shelf: a match is never hidden by the profile or type picked.
  const visible = found ?? rows.filter(inView);
  const typeCounts = (items.data ?? []).filter(row => profile === 'all' || !row.profile || row.profile === profile);
  const profileCount = (p: ProfileView) => (items.data ?? []).filter(row => p === 'all' || !row.profile || row.profile === p).length;
  const showComposer = dropping ?? items.data?.length === 0;

  function card(item: ShelfItem) { const status = statusOf(item); return <article className="shelf-card shelf-item" key={item.id}>
      {item.kind === 'photo' && item.object_path && (urls[item.object_path]
        ? <img className="shelf-photo" loading="lazy" decoding="async" src={urls[item.object_path]} alt={item.description ?? 'A photo on your Shelf'} />
        : <div className="shelf-photo placeholder" aria-hidden="true" />)}
      {item.kind === 'voice' && item.object_path && urls[item.object_path] &&
        <audio controls preload="none" src={urls[item.object_path]} aria-label="Play this voice note" />}
      {item.note && <h2 className="title">{item.note}</h2>}
      {item.transcript && <blockquote className="transcript">“{item.transcript}”</blockquote>}
      {item.description && !item.transcript && <p className={item.note ? 'muted' : 'title'}>{item.description}</p>}
      <Provenance parts={[KIND_LABEL[item.kind], profile === 'all' && item.profile ? PROFILE_LABEL[item.profile] : null, status.label]} at={item.created_at} />
      <div className="actions">
        <label className="visually-hidden" htmlFor={`profile-${item.id}`}>Profile</label>
        <select id={`profile-${item.id}`} className="field compact" value={item.profile ?? ''} disabled={act.busy && failedOn === item.id}
          onChange={event => void moveTo(item, (event.target.value || null) as ShelfItem['profile'])}>
          <option value="">No profile</option>
          <option value="work">Work</option>
          <option value="personal">Personal</option>
        </select>
        {item.status === 'ready' && !item.sorted_at && <Button small disabled={act.busy && failedOn === item.id}
          onClick={() => void sortNow(item)}>Look for to-dos</Button>}
        {status.retry && <Button small onClick={() => void read(item)}>Try reading it again</Button>}
        <Button look="quiet" small disabled={act.busy} aria-expanded={removing === item.id}
          onClick={() => setRemoving(removing === item.id ? null : item.id)}>Remove</Button>
      </div>
      {removing === item.id && <div className="notice" role="group" aria-label="Remove this from your Shelf?">
        <strong>Remove this from your Shelf?</strong>
        <p>It goes for good, with its file. Nothing can bring it back.</p>
        <div className="actions">
          <Button small disabled={act.busy} onClick={() => setRemoving(null)}>Keep it</Button>
          <Button look="danger" small disabled={act.busy} onClick={() => void remove(item)}>Remove for good</Button>
        </div>
      </div>}
      {readErrors[item.id] && <SaveError title="Could not read this." message={readErrors[item.id]} />}
      {act.error && failedOn === item.id && <SaveError title="Could not change this." message={act.error} />}
    </article>; }

  return <>
    <div className="head">
      <div className="col">
        <span className="eyebrow">Shelf</span>
        <h1>Your Shelf</h1>
        <p className="lede">Everything you dropped, sorted by topic, beside what needs you and your week ahead. Only you can see your Shelf.</p>
      </div>
      <Button onClick={() => { items.reload(); suggestions.reload(); }} disabled={items.loading}>Reload</Button>
    </div>

    <div className="shelf-bar">
      <Segments label="Profile" value={profile} onChange={key => view('profile', key)} items={[
        { key: 'all', label: 'All', count: profileCount('all') },
        { key: 'work', label: 'Work', count: profileCount('work') },
        { key: 'personal', label: 'Personal', count: profileCount('personal') }]} />
      <form className="shelf-search" role="search" onSubmit={find}>
        <TextField ref={searchBox} label="Find something" hint="describe it the way you remember it" value={query} maxLength={300}
          onChange={event => { setQuery(event.target.value); if (!event.target.value) setFound(null); }} />
        <Button type="submit" disabled={search.busy || !query.trim()}>{search.busy ? 'Looking…' : 'Find'}</Button>
      </form>
      <Button look={showComposer ? 'default' : 'primary'} aria-expanded={showComposer} onClick={() => setDropping(!showComposer)}>
        {showComposer ? 'Close' : 'Drop something'}</Button>
    </div>

    {showComposer && <form ref={form} className="composer expanded shelf-drop" onSubmit={submit} aria-label="Put something on your Shelf">
      <TextArea label="Note" hint="optional with a photo or voice note" limit={SHELF_LIMITS.note} rows={2}
        value={note} disabled={save.busy} onChange={event => setNote(event.target.value)} />
      <div className="row shelf-attach">
        <label className="btn sm">
          Add a photo or audio file
          <input ref={fileInput} type="file" className="visually-hidden" accept="image/*,audio/*" disabled={save.busy}
            onChange={event => pick(event.target.files?.[0] ?? null)} />
        </label>
        {recorder.recording
          ? <Button small look="danger" onClick={recorder.stop}>Stop recording</Button>
          : <Button small disabled={save.busy || recorder.starting} onClick={() => { setFile(null); void recorder.start(); }}>Record a voice note</Button>}
        {recorder.recording && <span className="fine" role="status">Recording…</span>}
        {attachment && !recorder.recording && <span className="fine" role="status">
          {file ? file.name : 'Voice note recorded'} · <Button look="link" small
            onClick={() => { setFile(null); recorder.clear(); if (fileInput.current) fileInput.current.value = ''; }}>remove</Button>
        </span>}
      </div>
      {recorder.error && <SaveError title="No voice note." message={recorder.error} />}
      {fileError && <SaveError title="Not that file." message={fileError} />}
      {save.error && <SaveError message={save.error} />}
      <div className="actions">
        <span className="fine muted">Photos and voice notes up to 20 MB.</span>
        <Button type="submit" look="primary" disabled={!canSave}>{save.busy ? 'Saving…' : 'Put on Shelf'}</Button>
      </div>
    </form>}

    <div className="shelf-home">
      <section className="shelf-main" aria-label={found ? 'Search results' : 'Your Shelf, by topic'}>
        {search.error && <SaveError title="Could not search." message={search.error} />}
        {items.error && <LoadError what="Your Shelf" message={items.error} onReload={items.reload} />}
        {items.loading && !items.data && <Skeleton rows={3} />}
        {items.data && !found && items.data.length === 0 && <Empty title="Your Shelf is empty">
          Put a note, a photo or a voice note on it above. It is read in a few seconds and sorted into a topic.
        </Empty>}
        {items.data && !found && items.data.length > 0 && visible.length === 0 && <Empty title="Nothing here">
          Nothing on your Shelf fits this profile and type. Pick Everything or All to see the rest.
        </Empty>}
        {found && <div className="row shelf-found">
          <p className="fine muted" role="status">{visible.length ? `${count(visible.length, 'match', 'matches')}, closest first.` : 'Nothing on your Shelf fits that. Try other words, the way you would describe it to someone.'}</p>
          <Button look="quiet" small onClick={() => { setFound(null); setQuery(''); }}>Show everything</Button>
        </div>}
        {found
          ? <div className="shelf-grid">{visible.map(card)}</div>
          : sectionsOf(visible).map(section => <details key={section.key} className="shelf-section" open>
            <summary><span className="name">{section.name}</span>
              <span className="eyebrow">{count(section.items.length, 'thing', 'things')}</span></summary>
            <div className="shelf-grid">{section.items.map(card)}</div>
          </details>)}
      </section>

      <aside className="shelf-side" aria-label="What needs you">
        <div className="shelf-side-top">
          <Suggestions loaded={suggestions} profile={profile} />
          <nav className="shelf-panel shelf-types" aria-label="Type">
            {TYPES.map(t => <button key={t.key} type="button" aria-pressed={type === t.key} onClick={() => view('type', t.key)}>
              <span>{t.label}</span>
              <span className="mono">{t.key === 'all' ? typeCounts.length : typeCounts.filter(row => row.kind === t.key).length}</span>
            </button>)}
          </nav>
        </div>
        <ComingUp profile={profile} />
      </aside>
    </div>
  </>;
}
