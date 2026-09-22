import { type FormEvent } from 'react';
import { KINDS, MEMORY_LIMITS, type MemoryContent, type MemoryKind } from './model';
import { Button } from '../../ui/Button';
import { SelectField, TextArea, TextField } from '../../ui/Field';
import { SaveError } from '../../ui/Notice';

type Props = {
  content: MemoryContent; scopeLabel: string; open: boolean; busy: boolean; error: string;
  editing?: { revision: number } | null;
  onOpen: () => void; onChange: (content: MemoryContent) => void; onDiscard: () => void; onSave: () => void;
};

export function Composer({ content, scopeLabel, open, busy, error, editing, onOpen, onChange, onDiscard, onSave }: Props) {
  // The form only mounts once it is open, so autoFocus is enough and the
  // shared TextArea does not have to start forwarding refs.
  const canSave = content.statement.trim().length > 0;
  function submit(event: FormEvent) { event.preventDefault(); if (canSave) onSave(); }

  if (!open) return <div className="composer collapsed">
    <button type="button" className="opener" onClick={onOpen}>
      <span>Write something down</span><span className="fine">saving in {scopeLabel}</span>
    </button>
  </div>;

  return <form className="composer expanded" onSubmit={submit} aria-label={editing ? 'Correct this memory' : 'Write something down'}>
    <div className="between">
      <h3>{editing ? 'Correcting' : 'Write something down'}</h3>
      <span className="eyebrow">{editing ? `will save as revision ${editing.revision + 1}` : `saving in ${scopeLabel}`}</span>
    </div>
    <div className="grid">
      <TextArea autoFocus label="The memory" hint="one sentence that will still make sense in six weeks" limit={MEMORY_LIMITS.statement} value={content.statement}
        disabled={busy} required rows={2} onChange={event => onChange({ ...content, statement: event.target.value })} />
      <TextField label="Handle" hint="optional. Most memories do not need one" limit={MEMORY_LIMITS.name} value={content.name}
        disabled={busy} onChange={event => onChange({ ...content, name: event.target.value })} />
    </div>
    {/* Not decoration. The kind decides how long the memory lives and whether
        anything may ever retire it: only something you wanted can be finished,
        and a fact stays until something makes it false. The person writing it
        is the only one who knows which it is. */}
    <SelectField label="What kind of thing is this" hint={KINDS.find(k => k.value === content.kind)?.hint}
      value={content.kind} disabled={busy || Boolean(editing)}
      onChange={event => onChange({ ...content, kind: event.target.value as MemoryKind })}>
      {KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
    </SelectField>
    <details open={content.more_info.length > 0}>
      <summary>Add more info (optional)</summary>
      <TextArea label="More info" limit={MEMORY_LIMITS.more_info} value={content.more_info} disabled={busy} rows={6} className="serif"
        onChange={event => onChange({ ...content, more_info: event.target.value })} />
    </details>
    {error && <SaveError message={error} />}
    <div className="actions">
      <span className="fine muted">{editing ? `Revision ${editing.revision} stays in history · the kind does not change on a correction` : 'Name and description form the index. More info is read on demand.'}</span>
      <div className="row">
        <Button look="quiet" disabled={busy} onClick={onDiscard}>{editing ? 'Discard changes' : 'Discard'}</Button>
        <Button type="submit" look="primary" disabled={busy || !canSave}>{busy ? 'Saving…' : editing ? 'Save correction' : 'Save memory'}</Button>
      </div>
    </div>
  </form>;
}
