import { useState, type FormEvent } from 'react';
import type { Project } from './repository';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { TextArea, TextField } from '../../ui/Field';
import { SaveError } from '../../ui/Notice';

type Props = { projects: Project[]; busy: boolean; error: string; onCancel: () => void; onCreate: (id: string, name: string, brief: string) => void };

export function NewProjectSheet({ projects, busy, error, onCancel, onCreate }: Props) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const duplicate = projects.some(project => project.name.trim().toLowerCase() === name.trim().toLowerCase());

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    if (duplicate && !confirmDuplicate) { setConfirmDuplicate(true); return; }
    onCreate(id, name, brief);
  }
  return <Sheet title="New project" onClose={onCancel}>
    <form className="stack" onSubmit={submit}>
      <div className="col" style={{ gap: 6 }}>
        <span className="eyebrow">New project</span>
        <h2>Name the effort, not the repo.</h2>
        <p className="muted">A project can hold many repositories or none. You can link codebases on the next page.</p>
      </div>
      <TextField label="Name" limit={100} required autoFocus value={name} disabled={busy} onChange={e => { setName(e.target.value); setConfirmDuplicate(false); }} />
      <TextArea label="Brief" hint="one or two lines an agent reads to tell this apart from your other projects" limit={1000} rows={3} value={brief} disabled={busy} onChange={e => setBrief(e.target.value)} />
      {confirmDuplicate && <div className="notice amber"><strong>A project with this name already exists.</strong><p>Create a second one anyway? Agents pick projects by name, so two with the same name can confuse them.</p></div>}
      {error && <SaveError message={error} />}
      <div className="between">
        <span className="fine muted">Opens the new project page</span>
        <div className="row" style={{ gap: 8 }}>
          <Button disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" look="primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : confirmDuplicate ? 'Create anyway' : 'Create project'}</Button>
        </div>
      </div>
    </form>
  </Sheet>;
}
