import { useState, type FormEvent } from 'react';
import type { Project, ProjectRepositoryLink } from './repository';

type Props = {
  project: Project;
  busy: boolean;
  onLink: (value: string) => Promise<boolean>;
  onUnlink: (link: ProjectRepositoryLink) => Promise<boolean>;
};

export function RepositoryLinks({ project, busy, onLink, onUnlink }: Props) {
  const [value, setValue] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onLink(value)) setValue('');
  }
  return <section className="repository-links" aria-labelledby="repository-links-heading">
    <div className="eyebrow">LINKED CODEBASES</div>
    <h2 id="repository-links-heading">Repositories</h2>
    <p className="muted fine">A linked repository lets Satchel select this project for a coding conversation. Linking never grants an agent access by itself.</p>
    {project.project_repositories.length > 0 && <ul>
      {project.project_repositories.map(link => <li key={`${link.provider}:${link.repository}`}>
        <span>{link.repository}</span>
        <button className="quiet" disabled={busy} onClick={() => void onUnlink(link)}>Unlink</button>
      </li>)}
    </ul>}
    <form onSubmit={submit}>
      <label>GitHub repository
        <input required placeholder="owner/repository" value={value} disabled={busy}
          onChange={event => setValue(event.target.value)} />
      </label>
      <button disabled={busy || !value.trim()}>Link repository</button>
    </form>
  </section>;
}
