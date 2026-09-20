import type { FormEvent } from 'react';
import { MEMORY_LIMITS, type MemoryContent } from './model';

type Props = {
  content: MemoryContent; editing: boolean; busy: boolean; destination: string;
  onChange: (content: MemoryContent) => void; onDiscard: () => void; onSave: () => void;
};

export function MemoryEditor({ content, editing, busy, destination, onChange, onDiscard, onSave }: Props) {
  const hasDraft = Boolean(content.statement || content.name || content.more_info);
  function submit(event: FormEvent) { event.preventDefault(); onSave(); }
  return <form className="composer" onSubmit={submit}>
    <h2>{editing ? 'Correct this memory' : 'Write something down'}</h2>
    <p className="muted fine">Saving in: <strong>{destination}</strong></p>
    {/* One sentence. Measured across real captured memories the median was 133
        characters, so a name and a summary were carrying something smaller than
        themselves. */}
    <label>The memory<textarea className="statement-input" required maxLength={MEMORY_LIMITS.statement}
      value={content.statement} disabled={busy}
      onChange={e => onChange({ ...content, statement: e.target.value })}
      placeholder="One sentence that will still make sense in six weeks." /></label>
    <p className="muted fine">{content.statement.length}/{MEMORY_LIMITS.statement} · This is what an agent sees, in full.</p>
    <details><summary>Optional</summary>
      <label>Handle <span className="muted">(optional)</span><input maxLength={MEMORY_LIMITS.name}
        value={content.name} disabled={busy} onChange={e => onChange({ ...content, name: e.target.value })}
        placeholder="writing-preferences" /></label>
      <label>More info <span className="muted">(rarely needed)</span><textarea maxLength={MEMORY_LIMITS.more_info}
        value={content.more_info} disabled={busy} onChange={e => onChange({ ...content, more_info: e.target.value })}
        placeholder="Long detail lives here and is fetched only when it matters." /></label>
    </details>
    <div className="compose-actions"><span className="muted fine">Saved here means confirmed</span>
      <div>{(editing || hasDraft) && <button type="button" className="quiet" disabled={busy} onClick={onDiscard}>Discard draft</button>}
        <button className="primary" disabled={busy || !content.statement.trim()}>
          {busy ? 'Working…' : editing ? 'Save correction' : 'Save memory'}</button></div>
    </div>
  </form>;
}
