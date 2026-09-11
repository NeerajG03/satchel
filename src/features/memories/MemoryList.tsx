import type { Memory, MemorySummary } from './model';

type Props = {
  memories: MemorySummary[]; expanded: Memory | null; deleteTarget: MemorySummary | null;
  busy: boolean; hasDraft: boolean;
  onRead: (memory: MemorySummary) => void; onHide: () => void;
  onCorrect: (memory: MemorySummary) => void; onAskDelete: (memory: MemorySummary | null) => void;
  onDelete: (memory: MemorySummary) => void;
};

export function MemoryList({ memories, expanded, deleteTarget, busy, hasDraft, onRead, onHide, onCorrect, onAskDelete, onDelete }: Props) {
  return <div>{memories.map(memory => <article key={memory.id}>
    <h2 className="memory-name">{memory.name}</h2><p className="memory-description">{memory.description}</p>
    <button className="quiet" disabled={busy} aria-expanded={expanded?.id === memory.id}
      onClick={() => expanded?.id === memory.id ? onHide() : onRead(memory)}>
      {expanded?.id === memory.id ? 'Hide more info' : 'Read more info'}</button>
    {expanded?.id === memory.id && <p className="memory-body">{expanded.more_info || 'No additional details.'}</p>}
    <div className="memory-meta"><span className="muted fine">Revision {memory.revision} · {new Date(memory.updated_at).toLocaleString()}</span>
      <div><button className="quiet" disabled={busy || hasDraft} onClick={() => onCorrect(memory)}>Correct</button>
        <button className="quiet" disabled={busy} onClick={() => onAskDelete(memory)}>Delete</button></div></div>
    {deleteTarget?.id === memory.id && <div className="notice" role="group" aria-label="Confirm deletion">
      <p>Delete this memory from Satchel? Copies in previous chats or exports are unaffected.</p>
      <button className="danger" disabled={busy} onClick={() => onDelete(memory)}>Delete memory</button>{' '}
      <button className="quiet" disabled={busy} onClick={() => onAskDelete(null)}>Keep it</button></div>}
  </article>)}</div>;
}
