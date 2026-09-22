import type { ReactNode } from 'react';
import { kindLabel, type Memory, type MemorySummary } from './model';
import { Button } from '../../ui/Button';
import { TornPageIcon } from '../../ui/TornPageIcon';
import { Provenance } from '../../ui/Provenance';

type Props = {
  memory: MemorySummary; expanded: Memory | null; busy: boolean; dim: boolean; fresh: boolean;
  confirmingForget: boolean; canCorrect: boolean; highlight: (text: string) => ReactNode;
  onRead: () => void; onHide: () => void; onCorrect: () => void; onAskForget: (ask: boolean) => void; onForget: () => void;
};

export function MemoryEntry({ memory, expanded, busy, dim, fresh, confirmingForget, canCorrect, highlight, onRead, onHide, onCorrect, onAskForget, onForget }: Props) {
  const open = expanded?.id === memory.id;
  return <article className={`entry ${dim ? 'dim' : ''} ${fresh ? 'fresh' : ''}`.trim()}>
    <div className="between" style={{ alignItems: 'flex-start' }}>
      <h2 className="title">{highlight(memory.statement)}</h2>
      <Button look="quiet" small className="tear" disabled={busy} aria-label={`Forget: ${memory.statement}`} title="Forget this memory"
        aria-expanded={confirmingForget} onClick={() => onAskForget(!confirmingForget)}><TornPageIcon /></Button>
    </div>
    {open && <p className="body">{expanded?.more_info || <span className="muted">No more info on this one.</span>}</p>}
    <div className="between wrap">
      <Provenance parts={[memory.name && `handle ${memory.name}`,
        // What kind of claim it is, because it decides what can happen to it:
        // only something you wanted can be finished and retired, and a fact
        // stays until something makes it false.
        kindLabel(memory.kind).toLowerCase(),
        // Said again, across sessions. Repetition is the strongest evidence
        // there is that a memory is real, and it is also what keeps a memory
        // at the top of the block when the block is full.
        memory.mentions > 1 && `said ${memory.mentions} times`,
        // Heard means Satchel picked it up rather than being asked, and an
        // agent has to say it out loud before relying on it. Saying so here is
        // what makes confirming it mean something.
        memory.band === 'heard' && 'heard, not confirmed',
        `revision ${memory.revision}`]} at={memory.updated_at} />
      <div className="actions">
        <Button look="quiet" small disabled={busy || !canCorrect} onClick={onCorrect}>Correct</Button>
        <Button look="quiet" small disabled={busy} aria-expanded={open} onClick={open ? onHide : onRead}>{open ? 'Hide more info' : 'Read more info'}</Button>
      </div>
    </div>
    {confirmingForget && <div className="notice" role="group" aria-label="Forget this memory?">
      <strong>Forget this memory?</strong>
      <p>It stops loading right away and waits in the archive, so you can bring it back. Copies in earlier chats, exports and an app’s own memory are not touched. Satchel can’t reach those.</p>
      <div className="actions">
        <Button small disabled={busy} onClick={() => onAskForget(false)}>Keep it</Button>
        <Button look="danger" small disabled={busy} onClick={onForget}>Forget</Button>
      </div>
    </div>}
  </article>;
}
