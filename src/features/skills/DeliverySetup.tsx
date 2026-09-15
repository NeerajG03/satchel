import { useState, type FormEvent } from 'react';
import { normalizeRepository, type Delivery } from './model';

type Props = {
  delivery: Delivery | null; slug: string; busy: boolean;
  installationId?: number;
  onConnect: (repository: string, installationId: number) => Promise<boolean>;
};

export function DeliverySetup({ delivery, slug, busy, installationId, onConnect }: Props) {
  const [repository, setRepository] = useState('');
  const [manualId, setManualId] = useState(installationId ? String(installationId) : '');
  const normalized = normalizeRepository(repository);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!normalized) return;
    if (await onConnect(normalized, Number(manualId))) setRepository('');
  }
  if (delivery && !delivery.revoked_at) return <div className="notice" role="status">
    <p>Delivering from <strong>{delivery.repository}</strong> on <strong>{delivery.branch}</strong>.</p>
    <p className="muted fine">Satchel writes only the files it generates in that repository. Your
      <code> skills/</code> directory is never rewritten by a publish. Revoking the app in GitHub stops
      future writes; it does not remove a plugin already installed in an agent.</p>
  </div>;

  return <form className="composer" onSubmit={submit}>
    <h2>Connect a delivery repository</h2>
    <p className="muted fine">Two steps, once. Satchel does not create the repository, because that
      would need a far broader GitHub permission than writing to one you chose.</p>
    <ol className="fine">
      <li>Create an empty <strong>private</strong> repository, for example{' '}
        <a href="https://github.com/new?name=satchel-kit&visibility=private" target="_blank" rel="noreferrer">satchel-kit ↗</a>.</li>
      <li>Install the Satchel app on <strong>only that repository</strong>:{' '}
        <a href={`https://github.com/apps/${slug}/installations/new`} target="_blank" rel="noreferrer">install ↗</a>.
        GitHub sends you back here with the installation id.</li>
    </ol>
    <label>Repository<input required value={repository} disabled={busy} placeholder="owner/satchel-kit"
      onChange={event => setRepository(event.target.value)} /></label>
    <label>Installation id<input required inputMode="numeric" pattern="[0-9]+" value={manualId} disabled={busy}
      onChange={event => setManualId(event.target.value)} /></label>
    <p className="muted fine">Satchel checks with GitHub that this installation belongs to your account and
      covers this repository, on connect and again on every publish.</p>
    <div className="compose-actions"><span className="muted fine">
      {repository && !normalized ? 'Enter owner/name or a GitHub URL.' : 'Contents read and write only.'}</span>
      <button className="primary" disabled={busy || !normalized || !manualId}>
        {busy ? 'Checking…' : 'Connect repository'}</button></div>
  </form>;
}
