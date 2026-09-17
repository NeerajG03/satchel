import { useState, type FormEvent } from 'react';
import type { Project, ProjectRepositoryLink } from './repository';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/Field';

type Props = { project: Project; busy: boolean; onLink: (value: string) => Promise<boolean>; onUnlink: (link: ProjectRepositoryLink) => void };

export function RepositoryLinks({ project, busy, onLink, onUnlink }: Props) {
  const [value, setValue] = useState('');
  const [adding, setAdding] = useState(project.project_repositories.length === 0);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onLink(value)) { setValue(''); setAdding(false); }
  }
  return <section className="section">
    <div className="between"><h2>Linked codebases</h2>{!adding && <Button look="link" small onClick={() => setAdding(true)}>Link another</Button>}</div>
    {project.project_repositories.map(link => <div className="relation" key={`${link.provider}:${link.repository}`}>
      <span className="mono" style={{ fontSize: 14 }}>{link.repository}</span>
      <Button look="quiet" small disabled={busy} onClick={() => onUnlink(link)}>Unlink</Button>
    </div>)}
    {adding && <form className="row wrap" style={{ alignItems: 'flex-end' }} onSubmit={submit}>
      <div style={{ flexGrow: 1, minWidth: 240 }}><TextField label="GitHub repository" hint="owner/name or a GitHub URL" required value={value} disabled={busy} onChange={e => setValue(e.target.value)} /></div>
      <Button type="submit" disabled={busy || !value.trim()}>Link repository</Button>
      {project.project_repositories.length > 0 && <Button look="quiet" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button>}
    </form>}
    <p className="fine muted">A linked repository lets an agent pick this project for a coding chat. It does not grant access by itself.</p>
  </section>;
}
