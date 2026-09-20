import { useState, type FormEvent } from 'react';
import type { TaskDetail, TaskStatus } from './model';
import { Button } from '../../ui/Button';
import { CheckField, TextArea } from '../../ui/Field';
import { SaveError } from '../../ui/Notice';
import { lines } from './TaskCapture';

export type Mode = 'comment' | 'progress' | 'handoff';
export type UpdateInput = {
  mode: Mode; body: string; completed: string[]; decisions: string[]; validation: string[]; remaining: string[]; blockers: string[];
  nextAction: string; status: TaskStatus | null; resourceIds: string[];
};
type Props = { task: TaskDetail; busy: boolean; error: string; onSubmit: (input: UpdateInput) => Promise<boolean> };

const MODES: { key: Mode; label: string }[] = [{ key: 'comment', label: 'Add a comment' }, { key: 'progress', label: 'Record progress' }, { key: 'handoff', label: 'Record handoff' }];

export function UpdateComposer({ task, busy, error, onSubmit }: Props) {
  const [mode, setMode] = useState<Mode>('comment');
  const [body, setBody] = useState('');
  const [completed, setCompleted] = useState('');
  const [decisions, setDecisions] = useState('');
  const [validation, setValidation] = useState('');
  const [remaining, setRemaining] = useState('');
  const [blockers, setBlockers] = useState('');
  const [nextAction, setNextAction] = useState(task.next_action);
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const verified = task.resources.filter(resource => resource.upload_status === 'verified' || resource.kind === 'external_url');

  const ready = mode === 'comment' ? body.trim().length > 0 : mode === 'progress' ? body.trim().length > 0 : nextAction.trim().length > 0 && lines(validation).length > 0;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await onSubmit({ mode, body, completed: lines(completed), decisions: lines(decisions), validation: lines(validation),
      remaining: lines(remaining), blockers: lines(blockers), nextAction, status: null, resourceIds });
    if (ok) { setBody(''); setCompleted(''); setDecisions(''); setValidation(''); setRemaining(''); setBlockers(''); setResourceIds([]); }
  }

  return <form className="composer" onSubmit={submit} aria-label="Add to the timeline">
    <div className="between wrap">
      <div className="modes" role="group" aria-label="What to record">
        {MODES.map(item => <Button key={item.key} small aria-pressed={mode === item.key} onClick={() => setMode(item.key)}>{item.label}</Button>)}
      </div>
      {mode === 'handoff' && <span className="fine muted">A handoff is the stronger boundary. It needs validation evidence.</span>}
    </div>
    <TextArea label={mode === 'comment' ? 'Comment' : 'Summary'} rows={3} limit={4000} value={body} disabled={busy}
      placeholder="What changed, or what the next person should know." onChange={e => setBody(e.target.value)} />
    {mode !== 'comment' && <div className="grid">
      <TextArea label="Completed" hint="one per line" rows={2} value={completed} disabled={busy} onChange={e => setCompleted(e.target.value)} />
      <TextArea label="Decisions" hint="one per line" rows={2} value={decisions} disabled={busy} onChange={e => setDecisions(e.target.value)} />
      {mode === 'handoff' && <TextArea label="Validated" hint="one per line, required" rows={2} value={validation} disabled={busy} onChange={e => setValidation(e.target.value)} />}
      <TextArea label="Remaining" hint="one per line" rows={2} value={remaining} disabled={busy} onChange={e => setRemaining(e.target.value)} />
      <TextArea label="Blockers" hint="one per line" rows={2} value={blockers} disabled={busy} onChange={e => setBlockers(e.target.value)} />
      <TextArea label="Next action" hint={mode === 'handoff' ? 'required' : 'leave as is to keep the current one'} rows={2} limit={1000} value={nextAction} disabled={busy} onChange={e => setNextAction(e.target.value)} />
    </div>}
    {verified.length > 0 && <fieldset className="stack-tight" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="eyebrow" style={{ marginBottom: 6 }}>Reference</legend>
      {verified.map(resource => <CheckField key={resource.id} label={resource.label} checked={resourceIds.includes(resource.id)} disabled={busy}
        onChange={e => setResourceIds(e.target.checked ? [...resourceIds, resource.id] : resourceIds.filter(id => id !== resource.id))} />)}
    </fieldset>}
    {error && <SaveError message={error} />}
    <div className="actions">
      <span className="fine muted">Writes revision {task.revision + 1}. Nothing moves state from here; use Move to.</span>
      <Button type="submit" look="primary" disabled={busy || !ready}>{busy ? 'Saving…' : MODES.find(item => item.key === mode)!.label}</Button>
    </div>
  </form>;
}
