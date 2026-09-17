import { useState, type FormEvent } from 'react';
import type { TaskDetail } from './model';
import { stateWord } from '../../app/format';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { TextArea } from '../../ui/Field';
import { SaveError } from '../../ui/Notice';

type Props = { task: TaskDetail; busy: boolean; error: string; onCancel: () => void; onConfirm: (reason: string) => void };

export function BlockedSheet({ task, busy, error, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState(task.blocked_reason);
  function submit(event: FormEvent) { event.preventDefault(); if (reason.trim()) onConfirm(reason.trim()); }
  return <Sheet title="Move to Blocked" onClose={onCancel}>
    <form onSubmit={submit} className="stack">
      <div className="col" style={{ gap: 6 }}>
        <span className="eyebrow">Move to Blocked</span>
        <h2>What is in the way?</h2>
        <p className="muted">The reason shows on Left off and on the task list, so the next session knows what to clear first.</p>
      </div>
      <TextArea label="Blocker" rows={3} limit={2000} value={reason} required autoFocus disabled={busy} onChange={e => setReason(e.target.value)} />
      <p className="fine muted">This is recorded as a progress update with the reason as its body, so the timeline always shows why. One write, one revision.</p>
      {error && <SaveError message={error} />}
      <div className="between">
        <span className="eyebrow">{stateWord(task.status)} to blocked · revision {task.revision + 1}</span>
        <div className="row" style={{ gap: 8 }}>
          <Button disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" look="danger" disabled={busy || !reason.trim()}>{busy ? 'Moving…' : 'Move to Blocked'}</Button>
        </div>
      </div>
    </form>
  </Sheet>;
}
