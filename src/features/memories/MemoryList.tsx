import { handleOf, type Memory, type MemorySummary } from './model';

type Props = {
  memories: MemorySummary[]; expanded: Memory | null; deleteTarget: MemorySummary | null;
  busy: boolean; hasDraft: boolean;
  onRead: (memory: MemorySummary) => void; onHide: () => void;
  onCorrect: (memory: MemorySummary) => void; onConfirm: (memory: MemorySummary) => void;
  onAskDelete: (memory: MemorySummary | null) => void;
  onDelete: (memory: MemorySummary) => void;
};

export function MemoryList({ memories, expanded, deleteTarget, busy, hasDraft, onRead, onHide, onCorrect, onConfirm, onAskDelete, onDelete }: Props) {
  return <div>{memories.map(memory => <article key={memory.id}>
    <p className="memory-statement">{memory.statement}</p>
    {/* An unconfirmed memory is announced before it is used, so it has to be
        visible here as something you can disagree with in one click. */}
    {memory.band === 'heard' && <p className="notice fine" role="note">
      Picked up from a conversation, not confirmed. Satchel says this out loud before relying on it.{' '}
      <button className="quiet" disabled={busy} onClick={() => onConfirm(memory)}>That's right</button>
    </p>}
    {memory.has_more_info && <>
      <button className="quiet" disabled={busy} aria-expanded={expanded?.id === memory.id}
        onClick={() => expanded?.id === memory.id ? onHide() : onRead(memory)}>
        {expanded?.id === memory.id ? 'Hide more info' : 'Read more info'}</button>
      {expanded?.id === memory.id && <p className="memory-body">{expanded.more_info}</p>}
    </>}
    <div className="memory-meta">
      <span className="muted fine">
        {handleOf(memory.id)} · {memory.name ? `${memory.name} · ` : ''}
        revision {memory.revision} · {new Date(memory.updated_at).toLocaleString()}
      </span>
      <div><button className="quiet" disabled={busy || hasDraft} onClick={() => onCorrect(memory)}>Correct</button>
        <button className="quiet" disabled={busy} onClick={() => onAskDelete(memory)}>Delete</button></div></div>
    {deleteTarget?.id === memory.id && <div className="notice" role="group" aria-label="Confirm deletion">
      <p>Delete this memory from Satchel? Copies in previous chats or exports are unaffected.</p>
      <button className="danger" disabled={busy} onClick={() => onDelete(memory)}>Delete memory</button>{' '}
      <button className="quiet" disabled={busy} onClick={() => onAskDelete(null)}>Keep it</button></div>}
  </article>)}</div>;
}
