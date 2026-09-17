import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { OAuthAuthorizationDetails } from '@supabase/supabase-js';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useFooter } from '../../app/readout';
import type { Project } from '../projects/repository';
import { partnerSlug } from './repository';
import { Button } from '../../ui/Button';
import { CheckField } from '../../ui/Field';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';

export const RETURN_URL_KEY = 'satchel-connected-return';

type Group = { personal: boolean; ids: string[] };
const NONE: Group = { personal: false, ids: [] };

function ScopeGroup({ title, hint, group, projects, disabled, onChange, extras }: { title: string; hint: string; group: Group; projects: Project[]; disabled: boolean; onChange: (group: Group) => void; extras: React.ReactNode }) {
  const total = projects.length + 1;
  const chosen = (group.personal ? 1 : 0) + group.ids.length;
  return <fieldset className="panel" disabled={disabled} style={{ margin: 0 }}>
    <div className="between"><legend style={{ padding: 0 }}><h3>{title}</h3></legend><span className="eyebrow">{chosen} of {total}</span></div>
    <div className="between"><span className="fine muted">{hint}</span>
      <span className="tools"><Button look="link" small onClick={() => onChange({ personal: true, ids: projects.map(p => p.id) })}>Select all</Button><span className="muted">·</span><Button look="link" small onClick={() => onChange(NONE)}>None</Button></span></div>
    <div className="list">
      <CheckField label="For me" hint={`personal ${title.toLowerCase()}`} checked={group.personal} onChange={e => onChange({ ...group, personal: e.target.checked })} />
      {projects.map(p => <CheckField key={p.id} label={p.name} checked={group.ids.includes(p.id)} onChange={e => onChange({ ...group, ids: e.target.checked ? [...group.ids, p.id] : group.ids.filter(id => id !== p.id) })} />)}
    </div>
    <hr className="hr" />
    {extras}
  </fieldset>;
}

export function Consent() {
  const stores = useStores();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const authorizationId = params.get('authorization_id') ?? '';
  const valid = /^[a-z0-9_-]{1,200}$/i.test(authorizationId);
  const page = useLoad(async () => {
    const [projects, details] = await Promise.all([stores.projects.list(), stores.db.auth.oauth.getAuthorizationDetails(authorizationId)]);
    if (details.error) throw details.error;
    return { projects, details: details.data };
  }, [stores, authorizationId]);
  const action = useAction();
  const [memory, setMemory] = useState<Group>(NONE);
  const [tasks, setTasks] = useState<Group>(NONE);
  const [memoryWrite, setMemoryWrite] = useState(false);
  const [taskWrite, setTaskWrite] = useState(false);
  const [taskUpload, setTaskUpload] = useState(false);
  useFooter('Deny closes this and sends the app back');

  const details = page.data && 'client' in page.data.details ? page.data.details as OAuthAuthorizationDetails : null;
  useEffect(() => {
    if (page.data && 'redirect_url' in page.data.details && typeof page.data.details.redirect_url === 'string') location.assign(page.data.details.redirect_url);
  }, [page.data]);
  useEffect(() => { if (!valid) navigate('/apps', { replace: true }); }, [valid, navigate]);

  const projects = page.data?.projects ?? [];
  const anyMemory = memory.personal || memory.ids.length > 0;
  const anyTasks = tasks.personal || tasks.ids.length > 0;
  const all = () => ({ personal: true, ids: projects.map(p => p.id) });

  async function decide(approve: boolean) {
    if (!details) return;
    await action.run(async () => {
      if (approve) await stores.connections.grant({ clientId: details.client.id, label: details.client.name, personal: memory.personal, projectIds: memory.ids, canWrite: memoryWrite,
        taskPersonal: tasks.personal, taskProjectIds: tasks.ids, taskCanWrite: taskWrite, taskCanUpload: taskUpload });
      const result = approve ? await stores.db.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await stores.db.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (result.error) throw result.error;
      if (!approve) { location.assign(result.data.redirect_url); return; }
      try { sessionStorage.setItem(RETURN_URL_KEY, JSON.stringify({ url: result.data.redirect_url, name: details.client.name })); } catch { /* The page still offers Back to Apps. */ }
      navigate(`/apps/connected/${partnerSlug(details.client.name)}`, { replace: true });
    });
  }

  if (page.error) return <><h1>An app wants to connect.</h1><LoadError what="The request" onReload={page.reload} /></>;
  if (!details) return <><h1>An app wants to connect.</h1><Skeleton rows={5} /></>;

  return <>
    <div className="col" style={{ gap: 8 }}>
      <span className="eyebrow">An app wants to connect</span>
      <h1>{details.client.name} wants to read your Satchel.</h1>
      <p className="fine muted">Name supplied by the app · will return to {details.redirect_uri}</p>
    </div>
    <div className="row wrap"><span className="fine muted">Quick start:</span>
      <Button small onClick={() => { setMemory(all()); setTasks(all()); setMemoryWrite(false); setTaskWrite(false); setTaskUpload(false); }}>Read everything</Button>
      <Button small onClick={() => { setMemory(all()); setTasks(all()); setMemoryWrite(true); setTaskWrite(true); setTaskUpload(true); }}>Read and save everything</Button>
      <Button small look="quiet" onClick={() => { setMemory(NONE); setTasks(NONE); setMemoryWrite(false); setTaskWrite(false); setTaskUpload(false); }}>Clear all</Button>
    </div>
    <div className="two">
      <div className="consent-groups">
        <ScopeGroup title="Memory" hint="Scopes it can read" group={memory} projects={projects} disabled={action.busy} onChange={setMemory}
          extras={<CheckField label="Also allow saves, corrections and forgets" hint="only when you ask it to, in that chat" checked={memoryWrite} disabled={!anyMemory} onChange={e => setMemoryWrite(e.target.checked)} />} />
        <ScopeGroup title="Tasks" hint="Scopes it can read" group={tasks} projects={projects} disabled={action.busy} onChange={setTasks}
          extras={<div className="stack-tight">
            <CheckField label="Also allow creating tasks, updates, moves and handoffs" checked={taskWrite} disabled={!anyTasks} onChange={e => setTaskWrite(e.target.checked)} />
            <CheckField label="Also allow file uploads to task storage" checked={taskUpload} disabled={!anyTasks} onChange={e => setTaskUpload(e.target.checked)} />
          </div>} />
      </div>
      <aside>
        <div className="aside-block"><div className="between"><h3>What this means</h3></div>
          <p className="fine muted">Reading means the app’s hooks get the names and descriptions of memories in these scopes. It fetches More info by name only when it needs it.</p>
          <p className="fine muted">Writing still needs your explicit ask inside the chat. The app cannot save on its own.</p>
          <p className="fine muted">Projects you create later are not included. Add them from Apps.</p></div>
        <div className="aside-block"><div className="between"><h3>Summary</h3></div>
          <p className="fine">Memory: {anyMemory ? `${(memory.personal ? 1 : 0) + memory.ids.length} scopes · ${memoryWrite ? 'read and save' : 'read only'}` : 'nothing'}</p>
          <p className="fine">Tasks: {anyTasks ? `${(tasks.personal ? 1 : 0) + tasks.ids.length} scopes · ${taskWrite ? 'read and write' : 'read only'}${taskUpload ? ' · uploads' : ''}` : 'nothing'}</p></div>
      </aside>
    </div>
    {action.error && <SaveError message={action.error} />}
    <div className="row wrap">
      <Button look="primary" disabled={action.busy || (!anyMemory && !anyTasks)} onClick={() => void decide(true)}>{action.busy ? 'Working…' : 'Allow this access'}</Button>
      <Button disabled={action.busy} onClick={() => void decide(false)}>Deny</Button>
      <span className="fine muted">{!anyMemory && !anyTasks ? 'Choose at least one scope to allow.' : 'You can change or revoke this later in Apps.'}</span>
    </div>
  </>;
}
