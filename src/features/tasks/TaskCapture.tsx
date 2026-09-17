import { useEffect, useRef, useState, type FormEvent } from 'react';
import { EMPTY_TASK, type TaskDraft } from './model';
import { Button } from '../../ui/Button';
import { SelectField, TextArea, TextField } from '../../ui/Field';
import { SaveError } from '../../ui/Notice';

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);

type Props = { scopeLabel: string; open: boolean; busy: boolean; error: string; onOpen: () => void; onCancel: () => void; onSave: (draft: TaskDraft) => Promise<boolean> };

export function TaskCapture({ scopeLabel, open, busy, error, onOpen, onCancel, onSave }: Props) {
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_TASK);
  const [doneWhen, setDoneWhen] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) titleRef.current?.focus(); }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSave({ ...draft, done_when: lines(doneWhen) })) { setDraft(EMPTY_TASK); setDoneWhen(''); }
  }
  if (!open) return <div className="composer collapsed">
    <button type="button" className="opener" onClick={onOpen}><span>Capture a task</span><span className="fine">saving in {scopeLabel}</span></button>
  </div>;

  return <form className="composer expanded" onSubmit={submit} aria-label="Capture a task">
    <div className="between"><h3>Capture a task</h3><span className="eyebrow">saving in {scopeLabel}</span></div>
    <div className="grid">
      <TextField ref={titleRef} label="Title" limit={200} required value={draft.title} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} />
      <TextArea label="Next action" hint="the one concrete thing to do first" limit={1000} rows={2} value={draft.next_action} disabled={busy} onChange={e => setDraft({ ...draft, next_action: e.target.value })} />
    </div>
    <div className="grid">
      <SelectField label="Priority" value={draft.priority} disabled={busy} onChange={e => setDraft({ ...draft, priority: e.target.value as TaskDraft['priority'] })}>
        {PRIORITIES.map(value => <option key={value} value={value}>{value}</option>)}
      </SelectField>
    </div>
    <details>
      <summary>Add outcome, why, and done-when</summary>
      <div className="stack">
        <TextArea label="Outcome" hint="what is true when this is done" limit={1000} rows={2} value={draft.outcome} disabled={busy} onChange={e => setDraft({ ...draft, outcome: e.target.value })} />
        <TextArea label="Why" hint="the reason it matters" limit={4000} rows={2} value={draft.why} disabled={busy} onChange={e => setDraft({ ...draft, why: e.target.value })} />
        <TextArea label="Done when" hint="one per line, each becomes a checkbox" rows={3} value={doneWhen} disabled={busy} onChange={e => setDoneWhen(e.target.value)} />
      </div>
    </details>
    {error && <SaveError message={error} />}
    <div className="actions">
      <span className="fine muted">{draft.next_action.trim() ? 'Starts in Ready.' : 'Starts in Inbox. Move it to Ready when it has a next action.'}</span>
      <div className="row">
        <Button look="quiet" disabled={busy} onClick={onCancel}>Discard</Button>
        <Button type="submit" look="primary" disabled={busy || !draft.title.trim()}>{busy ? 'Saving…' : 'Capture task'}</Button>
      </div>
    </div>
  </form>;
}
