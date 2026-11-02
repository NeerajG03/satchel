import { useEffect, useRef, useState, type FormEvent } from 'react';
import { explain } from '../../client';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count } from '../../app/format';
import { kindOf, SHELF_LIMITS, type ShelfItem } from './repository';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { TextArea, TextField } from '../../ui/Field';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { Provenance } from '../../ui/Provenance';

const KIND_LABEL = { note: 'note', photo: 'photo', voice: 'voice note' } as const;
const STATUS_LABEL = { waiting: 'reading it…', reading: 'reading it…', ready: false, failed: 'could not read this one' } as const;
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
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRecorder();
  const save = useAction('save');
  const act = useAction('action');
  const [lastId, setLastId] = useState<string | null>(null);
  // Per item, so a slow read never locks the buttons on every other item.
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ShelfItem[] | null>(null);
  const search = useAction('action');

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
    const update = (row: ShelfItem) => row.id === item.id
      ? { ...row, status: result?.status ?? 'failed', description: result?.description ?? row.description } : row;
    items.replace(list => list.map(update));
    setFound(list => list && list.map(update));
    if (result?.status === 'ready') announce(item.kind === 'note' ? 'On your Shelf' : 'Read and on your Shelf');
  }
  const canRetry = (item: ShelfItem) => !reading.has(item.id) && (item.status === 'failed'
    || (item.status !== 'ready' && Date.now() - Date.parse(item.created_at) > LOST_AFTER_MS));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    const added = await save.run(() => stores.shelf.add({ note, file: attachment }));
    if (!added) return;
    items.replace(list => [added, ...list]);
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

  async function remove(item: ShelfItem) {
    setLastId(item.id);
    const done = await act.run(async () => { await stores.shelf.remove(item); return true; });
    if (!done) return;
    items.replace(list => list.filter(row => row.id !== item.id));
    setFound(list => list && list.filter(row => row.id !== item.id));
    setRemoving(null);
    searchBox.current?.focus();
    announce('Removed from your Shelf');
  }

  function pick(chosen: File | null) {
    save.clear();
    const fits = !chosen || Boolean(kindOf(chosen.type));
    setFileError(fits ? '' : 'The Shelf takes photos (JPEG, PNG, WebP, HEIC) and voice notes (WebM, M4A, MP3, WAV, OGG).');
    setFile(fits ? chosen : null); recorder.clear();
    if (!fits && fileInput.current) fileInput.current.value = '';
  }

  return <>
    <div className="head">
      <div className="col">
        <span className="eyebrow">Shelf</span>
        <h1>Drop it here, find it later.</h1>
        <p className="lede">A thought, a photo or a voice note. Satchel reads each one and writes down what it
          shows, so you can find it again by typing a few words. Only you can see your Shelf.</p>
      </div>
      <Button onClick={items.reload} disabled={items.loading}>Reload</Button>
    </div>

    <form ref={form} className="composer expanded shelf-drop" onSubmit={submit} aria-label="Put something on your Shelf">
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
    </form>

    <form className="row shelf-search" role="search" onSubmit={find}>
      <TextField ref={searchBox} label="Find something" hint="describe it the way you remember it" value={query} maxLength={300}
        onChange={event => { setQuery(event.target.value); if (!event.target.value) setFound(null); }} />
      <Button type="submit" disabled={search.busy || !query.trim()}>{search.busy ? 'Looking…' : 'Find'}</Button>
      {found && <Button look="quiet" onClick={() => { setFound(null); setQuery(''); }}>Show everything</Button>}
    </form>
    {search.error && <SaveError title="Could not search." message={search.error} />}

    {items.error && <LoadError what="Your Shelf" message={items.error} onReload={items.reload} />}
    {items.loading && !items.data && <Skeleton rows={3} />}
    {items.data && !found && rows.length === 0 && <Empty title="Your Shelf is empty">
      Put a note, a photo or a voice note on it above. It is read in a few seconds and you can find it by searching.
    </Empty>}
    {found && rows.length === 0 && <Empty title="Nothing on your Shelf fits that">
      Try other words, the way you would describe it to someone.
    </Empty>}
    {found && rows.length > 0 && <p className="fine muted" role="status">{count(rows.length, 'match', 'matches')}, closest first.</p>}

    <div>{rows.map(item => <article className="entry shelf-item" key={item.id}>
      {item.kind === 'photo' && item.object_path && (urls[item.object_path]
        ? <img className="shelf-photo" src={urls[item.object_path]} alt={item.description ?? 'A photo on your Shelf'} />
        : <div className="shelf-photo placeholder" aria-hidden="true" />)}
      {item.kind === 'voice' && item.object_path && urls[item.object_path] &&
        <audio controls preload="none" src={urls[item.object_path]} aria-label="Play this voice note" />}
      {item.note && <h2 className="title">{item.note}</h2>}
      {item.description && <p className={item.note ? 'muted' : 'title'}>{item.description}</p>}
      <Provenance parts={[KIND_LABEL[item.kind], canRetry(item) && item.status !== 'failed' ? 'not read yet' : STATUS_LABEL[item.status]]} at={item.created_at} />
      <div className="actions">
        {canRetry(item) && <Button small onClick={() => void read(item)}>Try reading it again</Button>}
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
      {act.error && lastId === item.id && <SaveError title="Could not change this." message={act.error} />}
    </article>)}</div>
  </>;
}
