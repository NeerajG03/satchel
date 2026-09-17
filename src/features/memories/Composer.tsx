import { useEffect, useRef, type FormEvent } from 'react';
import { MEMORY_LIMITS, type MemoryContent } from './model';
import { Button } from '../../ui/Button';
import { TextArea, TextField } from '../../ui/Field';
import { SaveError } from '../../ui/Notice';

type Props = {
  content: MemoryContent; scopeLabel: string; open: boolean; busy: boolean; error: string;
  editing?: { revision: number } | null;
  onOpen: () => void; onChange: (content: MemoryContent) => void; onDiscard: () => void; onSave: () => void;
};

export function Composer({ content, scopeLabel, open, busy, error, editing, onOpen, onChange, onDiscard, onSave }: Props) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) nameRef.current?.focus(); }, [open]);
  const canSave = content.name.trim().length > 0 && content.description.trim().length > 0;
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
      <TextField ref={nameRef} label="Name" hint="short, how an agent will find it" limit={MEMORY_LIMITS.name} value={content.name}
        disabled={busy} required onChange={event => onChange({ ...content, name: event.target.value })} />
      <TextArea label="Description" hint="one or two lines. This is what agents read first" limit={MEMORY_LIMITS.description} value={content.description}
        disabled={busy} required rows={2} onChange={event => onChange({ ...content, description: event.target.value })} />
    </div>
    <details open={content.more_info.length > 0}>
      <summary>Add more info (optional)</summary>
      <TextArea label="More info" limit={MEMORY_LIMITS.more_info} value={content.more_info} disabled={busy} rows={6} className="serif"
        onChange={event => onChange({ ...content, more_info: event.target.value })} />
    </details>
    {error && <SaveError message={error} />}
    <div className="actions">
      <span className="fine muted">{editing ? `Revision ${editing.revision} stays in history` : 'Name and description form the index. More info is read on demand.'}</span>
      <div className="row">
        <Button look="quiet" disabled={busy} onClick={onDiscard}>{editing ? 'Discard changes' : 'Discard'}</Button>
        <Button type="submit" look="primary" disabled={busy || !canSave}>{busy ? 'Saving…' : editing ? 'Save correction' : 'Save memory'}</Button>
      </div>
    </div>
  </form>;
}
