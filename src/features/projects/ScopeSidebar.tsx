import { useState, type FormEvent } from 'react';
import { PERSONAL_SCOPE, type MemoryScope } from '../memories/model';
import type { Project } from './repository';

type Props = {
  projects: Project[]; scope: MemoryScope; busy: boolean; navigationLocked: boolean;
  onSelect: (scope: MemoryScope) => void;
  onCreate: (id: string, name: string, brief: string) => Promise<boolean>;
};

export function ScopeSidebar({ projects, scope, busy, navigationLocked, onSelect, onCreate }: Props) {
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [id, setId] = useState(() => crypto.randomUUID());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onCreate(id, name, brief)) { setName(''); setBrief(''); setId(crypto.randomUUID()); }
  }
  return <aside>
    <div className="eyebrow">YOUR MEMORY</div>
    <nav aria-label="Memory scopes">
      <button aria-current={scope.kind === 'personal' ? 'page' : undefined} disabled={navigationLocked}
        onClick={() => onSelect(PERSONAL_SCOPE)}>For me</button>
      <div className="eyebrow scope-label">YOUR PROJECTS</div>
      {projects.map(project => <button key={project.id}
        aria-current={scope.kind === 'project' && scope.projectId === project.id ? 'page' : undefined}
        disabled={navigationLocked} onClick={() => onSelect({ kind: 'project', projectId: project.id })}>{project.name}</button>)}
    </nav>
    {navigationLocked && !busy && <p className="muted fine">Save or discard the memory draft to switch scope.</p>}
    <details><summary>New project</summary><form onSubmit={submit}>
      <label>Project name<input required maxLength={100} value={name} disabled={busy}
        onChange={e => { setName(e.target.value); setId(crypto.randomUUID()); }} /></label>
      <label>Brief <span className="muted">(optional)</span><textarea maxLength={1000} value={brief} disabled={busy}
        onChange={e => { setBrief(e.target.value); setId(crypto.randomUUID()); }} /></label>
      <button className="primary" disabled={busy || navigationLocked || !name.trim()}>Create project</button>
    </form></details>
  </aside>;
}
