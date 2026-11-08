import { useState } from 'react';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { Button } from '../../ui/Button';
import type { ProfileKind } from '../profiles/repository';
import { SLOT_LABEL, type Column, type Fill, type NotionSettings, type Slot } from './repository';

type Props = { profile: ProfileKind; slot: Slot; connection: string; current?: Partial<NotionSettings>;
  onCancel: () => void; onSaved: (name: string) => void };

/**
 * Picks a Notion database for one slot and how its columns are filled. The
 * title column always takes the to-do's title, and the page body says what
 * was dropped; every other column is a fixed default the person sets once.
 */
export function NotionSetup({ profile, slot, connection, current, onCancel, onSaved }: Props) {
  const stores = useStores();
  const sources = useLoad(() => stores.integrations.sources(connection), [stores, connection]);
  const [source, setSource] = useState(current?.data_source_id ?? '');
  const schema = useLoad(() => source ? stores.integrations.schema(connection, source) : Promise.resolve(null), [stores, connection, source]);
  const [date, setDate] = useState<string | null | undefined>(current?.date);
  const [fills, setFills] = useState<Record<string, Fill>>(current?.defaults ?? {});
  const save = useAction('action');

  function choose(id: string) { setSource(id); setDate(undefined); setFills({}); }
  function fill(column: Column, value: Fill['value'] | null) {
    setFills(now => {
      const next = { ...now };
      if (value === null || (Array.isArray(value) && value.length === 0) || value === '') delete next[column.name];
      else next[column.name] = { type: column.type, value };
      return next;
    });
  }
  const dates = schema.data?.columns.filter(c => c.type === 'date') ?? [];
  // Until the person picks, a date column is filled if the database has one.
  const dateColumn = date === undefined ? dates[0]?.name ?? null : date;
  const title = schema.data?.columns.find(c => c.type === 'title');
  const others = schema.data?.columns.filter(c => c.type !== 'title' && c.type !== 'date') ?? [];

  async function submit() {
    const done = await save.run(async () => {
      await stores.integrations.setSlot(profile, slot, 'notion_database', connection, { data_source_id: source, date: dateColumn, defaults: fills });
      return true;
    });
    if (done) onSaved(schema.data?.name ?? 'Notion');
  }

  return <div className="notion-setup stack-tight" role="group" aria-label={`Notion for ${SLOT_LABEL[slot]}`}>
    {sources.loading && !sources.data && <Skeleton rows={1} />}
    {sources.error && <LoadError what="Your Notion databases" message={sources.error} onReload={sources.reload} />}
    {sources.data && sources.data.length === 0 && <p className="fine">Notion shared no databases with Satchel. Connect Notion again
      and tick the database on Notion’s screen.</p>}
    {sources.data && sources.data.length > 0 && <div className="f">
      <label htmlFor={`source-${profile}-${slot}`}>Database</label>
      <select id={`source-${profile}-${slot}`} className="field" value={source} onChange={event => choose(event.target.value)}>
        <option value="" disabled>Pick one</option>
        {sources.data.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>}
    {source && schema.loading && !schema.data && <Skeleton rows={3} />}
    {schema.error && <LoadError what="That database" message={schema.error} onReload={schema.reload} />}
    {schema.data && <>
      <p className="fine muted">Each new page gets the title in <strong>{title?.name ?? 'its title'}</strong>, and what you dropped
        in its body. Set the rest once:</p>
      <ul className="notion-columns">
        {dates.length > 0 && <li>
          <label htmlFor={`date-${profile}-${slot}`}>Day</label>
          <select id={`date-${profile}-${slot}`} className="field compact" value={dateColumn ?? ''}
            onChange={event => setDate(event.target.value || null)}>
            <option value="">Don’t fill a date</option>
            {dates.map(c => <option key={c.name} value={c.name}>Put the day in {c.name}</option>)}
          </select>
        </li>}
        {others.map(column => <li key={column.name}>
          <ColumnFill column={column} value={fills[column.name]?.value} id={`fill-${profile}-${slot}-${column.name}`}
            onChange={value => fill(column, value)} />
        </li>)}
      </ul>
    </>}
    {save.error && <SaveError title="That slot was not changed." message={save.error} />}
    <div className="row">
      <Button small disabled={!schema.data || save.busy} onClick={() => void submit()}>{save.busy ? 'Saving…' : 'Save'}</Button>
      <Button small look="quiet" disabled={save.busy} onClick={onCancel}>Cancel</Button>
    </div>
  </div>;
}

function ColumnFill({ column, value, id, onChange }: { column: Column; value: Fill['value'] | undefined; id: string;
  onChange: (value: Fill['value'] | null) => void }) {
  const [find, setFind] = useState('');
  const label = <label htmlFor={id}>{column.name}</label>;
  if (column.type === 'select' || column.type === 'status') return <>{label}
    <select id={id} className="field compact" value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value || null)}>
      <option value="">Leave empty</option>
      {column.options!.map(o => <option key={o} value={o}>{o}</option>)}
    </select></>;
  if (column.type === 'people') return <>{label}
    <select id={id} className="field compact" value={value === 'me' ? 'me' : ''} onChange={e => onChange(e.target.value || null)}>
      <option value="">Leave empty</option>
      <option value="me">Me</option>
    </select></>;
  if (column.type === 'checkbox') return <>{label}
    <select id={id} className="field compact" value={value === true ? 'yes' : value === false ? 'no' : ''}
      onChange={e => onChange(e.target.value === '' ? null : e.target.value === 'yes')}>
      <option value="">Leave as Notion sets it</option>
      <option value="yes">Ticked</option>
      <option value="no">Not ticked</option>
    </select></>;
  if (column.type === 'rich_text') return <>{label}
    <input id={id} className="field compact" maxLength={2000} value={typeof value === 'string' ? value : ''} placeholder="Leave empty"
      onChange={e => onChange(e.target.value)} /></>;
  // A multi-select: tick any of its choices. A long list is searched rather than shown whole.
  const picked = Array.isArray(value) ? value : [];
  const options = column.options!;
  const shown = options.length <= 12 ? options
    : options.filter(o => picked.includes(o) || (find && o.toLowerCase().includes(find.toLowerCase()))).slice(0, 30);
  return <fieldset className="choices"><legend>{column.name}</legend>
    {options.length === 0 && <span className="fine muted">No choices in Notion yet</span>}
    {options.length > 12 && <input className="field compact" aria-label={`Find a ${column.name} choice`} value={find}
      placeholder={`Find one of ${options.length}`} onChange={e => setFind(e.target.value)} />}
    {shown.map(o => <label key={o} className="choice">
      <input type="checkbox" checked={picked.includes(o)}
        onChange={e => onChange(e.target.checked ? [...picked, o] : picked.filter(p => p !== o))} /> {o}
    </label>)}
  </fieldset>;
}
