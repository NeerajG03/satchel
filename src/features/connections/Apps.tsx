import { useState } from 'react';
import { Link } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter, useReadout } from '../../app/readout';
import { count, whenText } from '../../app/format';
import type { Connection } from './repository';
import type { Project } from '../projects/repository';
import { Button } from '../../ui/Button';
import { Light } from '../../ui/Light';
import { LoadError, Notice, SaveError, Skeleton } from '../../ui/Notice';
import { CommandBlock } from '../../ui/CommandBlock';
import { HOST_NAMES, INSTALL, LOGIN, PROMPT, type Host } from './install';

function GrantLine({ personal, ids, projects, level }: { personal: boolean; ids: string[]; projects: Project[]; level: string }) {
  const names = [...(personal ? ['For me'] : []), ...ids.map(id => projects.find(p => p.id === id)?.name ?? 'a removed project')];
  if (!names.length) return <dd>none</dd>;
  return <dd>{names.join(', ')} <span className="muted fine">· {level}</span></dd>;
}

function AppCard({ app, projects, busy, confirming, onAskRevoke, onRevoke }: { app: Connection; projects: Project[]; busy: boolean; confirming: boolean; onAskRevoke: (ask: boolean) => void; onRevoke: () => void }) {
  const taskIds = app.agent_task_grants.map(g => g.project_id);
  return <article className="card">
    <div className="between wrap"><h2 style={{ fontSize: 22 }}>{app.label}</h2>
      <Light color="green" word={app.can_write || app.task_can_write ? 'reads and saves' : 'reads only'} /></div>
    <dl className="grants">
      <dt>Memory</dt><GrantLine personal={app.personal} ids={app.project_ids} projects={projects} level={app.can_write ? 'read and save' : 'read only'} />
      <dt>Tasks</dt><GrantLine personal={app.task_personal} ids={taskIds} projects={projects} level={[app.task_can_write ? 'read, write' : 'read only', app.task_can_upload && 'upload'].filter(Boolean).join(' and ')} />
    </dl>
    <p className="fine muted">Connected {whenText(app.created_at)} · a permission here applies to every installation using this app identity.</p>
    {!confirming && <div className="card-actions"><Button small disabled={busy} onClick={() => onAskRevoke(true)}>Revoke access</Button></div>}
    {confirming && <div className="notice" role="group" aria-label="Revoke access?">
      <strong>Revoke {app.label}’s access?</strong>
      <p>It stops reading and saving right away. Anything it already read stays in that app. Satchel can’t reach that.</p>
      <div className="actions"><Button small disabled={busy} onClick={() => onAskRevoke(false)}>Keep it</Button><Button small look="danger" disabled={busy} onClick={onRevoke}>{busy ? 'Revoking…' : 'Revoke'}</Button></div>
    </div>}
  </article>;
}

export function Apps() {
  const stores = useStores();
  const { announce } = useReadout();
  const page = useLoad(async () => {
    const [connections, projects] = await Promise.all([stores.connections.list(), stores.projects.list()]);
    return { connections, projects };
  }, [stores]);
  const action = useAction();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const data = page.data;
  const live = data?.connections.filter(c => !c.revoked_at) ?? [];
  useFooter(data ? `${count(live.length, 'app')} connected` : '', data && live.length === 0 ? { light: 'amber', word: 'No apps connected' } : undefined);
  const [host, setHost] = useState<Host>('claude');
  async function copyPrompt() { try { await navigator.clipboard.writeText(PROMPT[host]); announce(`Prompt for ${HOST_NAMES[host]} copied`); } catch { announce('Copy failed'); } }

  async function revoke(app: Connection) {
    const result = await action.run(() => stores.connections.revoke(app));
    if (!result) return;
    setConfirmId(null); page.reload();
    announce(result.oauthCleanupFailed ? `${app.label} access revoked · clear its sign-in inside the app before reconnecting` : `${app.label} access revoked · earlier reads stay in that app`);
  }

  return <>
    <div className="head"><div className="col"><span className="eyebrow">Apps</span><h1>Apps.</h1>
      <p className="lede">Each app gets only the scopes you chose. A permission here applies to every installation using that app identity.</p></div></div>
    {page.error && <LoadError what="Your apps" onReload={page.reload} />}
    {page.loading && !data && <Skeleton rows={3} />}
    {action.error && <SaveError message={action.error} />}
    {data && live.length === 0 && <>
      <p className="muted" style={{ maxWidth: 620 }}>Nothing is connected yet. An app gets only the memory and task scopes you grant when it first asks. You can revoke later.</p>
      <div className="steps lead-wide">
        <div className="step"><span className="n">01 · In your terminal</span><h3>Install the Satchel plugin</h3><p className="muted">Both apps install from the same public catalog. Pick yours.</p>
          <div className="row wrap"><Button small look={host === 'claude' ? 'primary' : 'default'} onClick={() => setHost('claude')}>Claude Code</Button><Button small look={host === 'codex' ? 'primary' : 'default'} onClick={() => setHost('codex')}>Codex</Button></div>
          <CommandBlock lines={INSTALL[host]} label={`${HOST_NAMES[host]} install commands`} />
          <p className="fine muted">Or let {HOST_NAMES[host]} do it. Copy a prompt, paste it into a {HOST_NAMES[host]} chat, and it runs the install for you.</p>
          <Button small onClick={() => void copyPrompt()}>Copy prompt for {HOST_NAMES[host]}</Button></div>
        <div className="step"><span className="n">02 · In the app</span><h3>Sign in</h3><p className="muted">The login command opens Satchel in your browser with a consent page. Nothing is granted until you allow it.</p>
          <CommandBlock lines={[LOGIN[host]]} label={`${HOST_NAMES[host]} login command`} /></div>
        <div className="step"><span className="n">03 · Back here</span><h3>See it connected</h3><p className="muted">The app appears in this list with a green light once you allow it.</p><Light color="amber" word="Waiting for the first connection" /></div>
      </div>
      <Notice>What a connected app can never do: read scopes you didn’t grant, save without both write permission and your explicit ask, or see More info in bulk. Hooks read names and descriptions only.</Notice>
    </>}
    {data && live.length > 0 && <div className="cards">
      {live.map(app => <AppCard key={app.client_id} app={app} projects={data.projects} busy={action.busy} confirming={confirmId === app.client_id}
        onAskRevoke={ask => setConfirmId(ask ? app.client_id : null)} onRevoke={() => void revoke(app)} />)}
    </div>}
    {data && live.length > 0 && <p className="fine muted">To connect another app, install the plugin there and run its login command. It sends you here to a consent page. <Link to="/settings">Settings</Link> explains export and forgetting.</p>}
  </>;
}
