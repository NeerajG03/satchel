import type { FormEvent } from 'react';
import { MEMORY_LIMITS, type MemoryContent } from './model';

type Props = {
  content: MemoryContent; editing: boolean; busy: boolean; destination: string;
  onChange: (content: MemoryContent) => void; onDiscard: () => void; onSave: () => void;
};

export function MemoryEditor({ content, editing, busy, destination, onChange, onDiscard, onSave }: Props) {
  const hasDraft = Boolean(content.name || content.description || content.more_info);
  function submit(event: FormEvent) { event.preventDefault(); onSave(); }
  return <form className="composer" onSubmit={submit}>
    <h2>{editing ? 'Correct this memory' : 'Write something down'}</h2>
    <p className="muted fine">Saving in: <strong>{destination}</strong></p>
    <label>Name<input required maxLength={MEMORY_LIMITS.name} value={content.name} disabled={busy}
      onChange={e => onChange({ ...content, name: e.target.value })} placeholder="writing-preferences" /></label>
    <label>Description<textarea className="description-input" required maxLength={MEMORY_LIMITS.description}
      value={content.description} disabled={busy} onChange={e => onChange({ ...content, description: e.target.value })}
      placeholder="What this memory covers and when to read it." /></label>
    <p className="muted fine">Name and description form the memory index. More info is read separately when needed.</p>
    <label>More info <span className="muted">(optional)</span><textarea maxLength={MEMORY_LIMITS.more_info}
      value={content.more_info} disabled={busy} onChange={e => onChange({ ...content, more_info: e.target.value })}
      placeholder="Add the full context, decisions, examples or references." /></label>
    <div className="compose-actions"><span className="muted fine">{content.more_info.length}/{MEMORY_LIMITS.more_info} · Explicit saves only</span>
      <div>{(editing || hasDraft) && <button type="button" className="quiet" disabled={busy} onClick={onDiscard}>Discard draft</button>}
        <button className="primary" disabled={busy || !content.name.trim() || !content.description.trim()}>
          {busy ? 'Working…' : editing ? 'Save correction' : 'Save memory'}</button></div>
    </div>
  </form>;
}
