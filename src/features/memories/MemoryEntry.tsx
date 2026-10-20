import { useId, type ReactNode } from 'react';
import { kindLabel, type Memory, type MemorySummary } from './model';
import { dated, shortWhen, type Change } from './ledger';
import { Button } from '../../ui/Button';
import { TornPageIcon } from '../../ui/TornPageIcon';
import { Provenance } from '../../ui/Provenance';
import { fullDate } from '../../app/format';

const WHY_WORD = { new: 'New', again: 'Said again', changed: 'Changed' } as const;
const WHY_CHIP = { new: 'chip progress', again: 'chip', changed: 'chip amber' } as const;

type Props = {
  memory: MemorySummary; change: Change; open: boolean; expanded: Memory | null; busy: boolean; dim: boolean; fresh: boolean;
  tagged: boolean; wrap: boolean; confirmingForget: boolean; canCorrect: boolean; highlight: (text: string) => ReactNode;
  onToggle: () => void; onRead: () => void; onHide: () => void; onCorrect: () => void;
  onAskForget: (ask: boolean) => void; onForget: () => void;
};

// One line until it is opened, because a book of fifty memories has to fit on
// a screen or two for anyone to see what just came in.
export function MemoryEntry({ memory, change, open, expanded, busy, dim, fresh, tagged, wrap, confirmingForget, canCorrect, highlight,
  onToggle, onRead, onHide, onCorrect, onAskForget, onForget }: Props) {
  const detailId = useId();
  const reading = open && expanded?.id === memory.id;
  // Satchel wrote this one from something you said, rather than because you
  // asked. That is a fact about where it came from and nothing more. It is not
  // a request for approval: memory is hands off, and whether the person agrees
  // with a row is not what makes it one.
  const picked = memory.band === 'heard';
  // The source of a memory you wrote yourself is the sentence you wrote, so
  // repeating it would be noise. For a captured one it is the words you
  // actually typed, which is the only evidence the claim is really yours.
  const said = reading && expanded?.source?.trim() && expanded.source.trim() !== expanded.statement.trim()
    ? expanded.source.trim() : '';
  // has_more_info exists so this does not have to be a round trip to find out
  // there is nothing.
  const openable = memory.has_more_info || picked;
  const openLabel = memory.has_more_info ? 'Read more info' : 'See what you said';

  return <article className={`entry line ${open ? 'open' : ''} ${dim ? 'dim' : ''} ${fresh ? 'fresh' : ''}`.trim()}>
    <button type="button" className={`row ${wrap || open ? 'wrap' : ''}`} aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle}>
      <span className="why">{tagged && dated(memory) && <span className={WHY_CHIP[change.why]}>{WHY_WORD[change.why]}</span>}</span>
      <span className="statement">{highlight(memory.statement)}</span>
      <span className="claim">{kindLabel(memory.kind).toLowerCase()}</span>
      <time className="when" dateTime={change.at} title={fullDate(change.at)}>{shortWhen(change.at)}</time>
    </button>
    {open && <div className="detail" id={detailId}>
      {reading && expanded?.more_info && <p className="body">{expanded.more_info}</p>}
      {said && <p className="said"><span className="eyebrow">From what you said</span>{said}</p>}
      <div className="between wrap">
        <Provenance parts={[memory.name && `handle ${memory.name}`,
          // What kind of claim it is, because it decides what can happen to it:
          // only something you wanted can be finished and retired.
          kindLabel(memory.kind).toLowerCase(),
          // Repetition is the strongest evidence there is that a memory is real.
          memory.mentions > 1 && `said ${memory.mentions} times`,
          picked && 'picked up automatically',
          `revision ${memory.revision}`]} at={memory.updated_at} />
        <div className="actions">
          {/* No "is this right?" here, on purpose. A memory is a memory whether
              or not the person agrees with it. */}
          <Button look="quiet" small disabled={busy || !canCorrect} onClick={onCorrect}>Correct</Button>
          {openable && <Button look="quiet" small disabled={busy} aria-expanded={reading}
            onClick={reading ? onHide : onRead}>{reading ? 'Hide' : openLabel}</Button>}
          <Button look="quiet" small className="tear" disabled={busy} aria-label={`Forget: ${memory.statement}`} title="Forget this memory"
            aria-expanded={confirmingForget} onClick={() => onAskForget(!confirmingForget)}><TornPageIcon /></Button>
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
    </div>}
  </article>;
}
