import type { ReactNode } from 'react';
import { kindLabel, type Memory, type MemorySummary } from './model';
import { Button } from '../../ui/Button';
import { TornPageIcon } from '../../ui/TornPageIcon';
import { Provenance } from '../../ui/Provenance';

type Props = {
  memory: MemorySummary; expanded: Memory | null; busy: boolean; dim: boolean; fresh: boolean;
  confirmingForget: boolean; canCorrect: boolean; highlight: (text: string) => ReactNode;
  onRead: () => void; onHide: () => void; onCorrect: () => void;
  onAskForget: (ask: boolean) => void; onForget: () => void;
};

export function MemoryEntry({ memory, expanded, busy, dim, fresh, confirmingForget, canCorrect, highlight,
  onRead, onHide, onCorrect, onAskForget, onForget }: Props) {
  const open = expanded?.id === memory.id;
  // Satchel wrote this one from something you said, rather than because you
  // asked. That is a fact about where it came from and nothing more. It is not
  // a request for approval: memory is hands off, and whether the person agrees
  // with a row is not what makes it one.
  const picked = memory.band === 'heard';
  // The source of a memory you wrote yourself is the sentence you wrote, so
  // repeating it would be noise. For a captured one it is the words you
  // actually typed, which is the only evidence the claim is really yours.
  const said = open && expanded?.source?.trim() && expanded.source.trim() !== expanded.statement.trim()
    ? expanded.source.trim() : '';
  // has_more_info exists so this does not have to be a round trip to find out
  // there is nothing. It was computed in SQL, typed, computed again in the
  // model, and then read by nobody, so nine rows in eleven offered to open
  // something that was not there.
  const openable = memory.has_more_info || picked;
  const openLabel = memory.has_more_info ? 'Read more info' : 'See what you said';

  return <article className={`entry ${dim ? 'dim' : ''} ${fresh ? 'fresh' : ''}`.trim()}>
    <div className="between" style={{ alignItems: 'flex-start' }}>
      <h2 className="title">{highlight(memory.statement)}</h2>
      <Button look="quiet" small className="tear" disabled={busy} aria-label={`Forget: ${memory.statement}`} title="Forget this memory"
        aria-expanded={confirmingForget} onClick={() => onAskForget(!confirmingForget)}><TornPageIcon /></Button>
    </div>
    {open && <>
      {expanded?.more_info && <p className="body">{expanded.more_info}</p>}
      {said && <p className="said"><span className="eyebrow">From what you said</span>{said}</p>}
    </>}
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
        picked && 'picked up automatically',
        `revision ${memory.revision}`]} at={memory.updated_at} />
      <div className="actions">
        {/* No "is this right?" here, on purpose. A memory is a memory whether
            or not the person agrees with it, and a button asking them to
            approve their own memory turns a thing that is supposed to look
            after itself into a queue of chores. Capture quality is capture's
            problem to solve, not the reader's. */}
        <Button look="quiet" small disabled={busy || !canCorrect} onClick={onCorrect}>Correct</Button>
        {openable && <Button look="quiet" small disabled={busy} aria-expanded={open}
          onClick={open ? onHide : onRead}>{open ? 'Hide' : openLabel}</Button>}
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
