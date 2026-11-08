import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { Button } from '../../ui/Button';
import { PROFILE_LABEL, type ProfileKind } from '../profiles/repository';
import { PLUGINS, PROVIDER_LABEL, SLOT_LABEL, placeName, type Connection, type Destination, type PluginId, type Provider,
  type Slot } from './repository';
import { NotionSetup } from './NotionSetup';

const PROFILES: ProfileKind[] = ['personal', 'work'];
const SLOTS: Slot[] = ['todo', 'event'];
const choice = (plugin: PluginId, connection: string) => `${plugin}|${connection}`;

/** Settings section: the accounts Satchel may add to, and where each profile's to-dos and events go. */
export function Integrations() {
  const stores = useStores();
  const { announce } = useReadout();
  const loaded = useLoad(async () => {
    const [connections, destinations] = await Promise.all([stores.integrations.connections(), stores.integrations.destinations()]);
    return { connections, destinations };
  }, [stores]);
  const act = useAction('action');
  const [busy, setBusy] = useState('');
  // The slot whose Notion columns are being set, and on which workspace.
  const [setting, setSetting] = useState<{ profile: ProfileKind; slot: Slot; connection: string } | null>(null);
  const connected = (useLocation().state as { connected?: string } | null)?.connected;
  useEffect(() => { if (connected) announce(connected); }, [connected, announce]);

  async function connect(provider: Provider) {
    setBusy(provider);
    await act.run(() => stores.integrations.start(provider));
    setBusy('');
  }
  async function disconnect(c: Connection) {
    setBusy(c.id);
    const done = await act.run(async () => { await stores.integrations.disconnect(c.id); return true; });
    setBusy('');
    if (done) { loaded.reload(); announce(`${PROVIDER_LABEL[c.provider]} ${c.label} is disconnected`); }
  }
  async function pick(profile: ProfileKind, slot: Slot, value: string) {
    const [plugin, connection] = value ? value.split('|') as [PluginId, string] : [null, undefined];
    if (plugin === 'notion_database') { setSetting({ profile, slot, connection: connection! }); return; }
    setSetting(null);
    setBusy(`${profile}/${slot}`);
    const done = await act.run(async () => { await stores.integrations.setSlot(profile, slot, plugin, connection); return true; });
    setBusy('');
    if (done) {
      loaded.reload();
      announce(plugin ? `${PROFILE_LABEL[profile]} ${SLOT_LABEL[slot]} go to ${PLUGINS.find(p => p.id === plugin)!.label}`
        : `${PROFILE_LABEL[profile]} ${SLOT_LABEL[slot]} go nowhere for now`);
    }
  }

  const data = loaded.data;
  const slotOf = (profile: ProfileKind, slot: Slot): Destination | undefined =>
    data?.destinations.find(d => d.profile === profile && d.slot === slot);

  return <div className="settings-row">
    <h2>Where things go</h2>
    <div className="stack-tight">
      <p className="muted">Each profile has a to-do list and a calendar. Pick where each one lives: Google Tasks, Google
        Calendar or a Notion database. Nothing is added until you say yes on the Shelf.</p>
      {loaded.error && <LoadError what="Your connections" message={loaded.error} onReload={loaded.reload} />}
      {loaded.loading && !data && <Skeleton rows={3} />}
      {data && <>
        <ul className="profile-google">
          {data.connections.map(c => <li key={c.id}>
            <span><strong>{PROVIDER_LABEL[c.provider]}</strong> <span className="muted">· {c.label}</span></span>
            <Button small look="quiet" disabled={act.busy} onClick={() => void disconnect(c)}>{busy === c.id ? 'Disconnecting…' : 'Disconnect'}</Button>
          </li>)}
          {data.connections.length === 0 && <li className="fine muted">No accounts connected yet.</li>}
        </ul>
        <div className="row">
          <Button small disabled={act.busy} onClick={() => void connect('google')}>{busy === 'google' ? 'Opening Google…' : 'Connect Google'}</Button>
          <Button small disabled={act.busy} onClick={() => void connect('notion')}>{busy === 'notion' ? 'Opening Notion…' : 'Connect Notion'}</Button>
        </div>
        <ul className="profile-topics slots">
          {PROFILES.flatMap(profile => SLOTS.map(slot => {
            const current = slotOf(profile, slot);
            const id = `slot-${profile}-${slot}`;
            const open = setting?.profile === profile && setting.slot === slot;
            return <li key={id}>
              <label htmlFor={id}>{PROFILE_LABEL[profile]} · {SLOT_LABEL[slot]}</label>
              <span className="row">
                <select id={id} className="field" disabled={act.busy}
                  value={open ? choice('notion_database', setting.connection) : current ? choice(current.plugin, current.connection_id) : ''}
                  onChange={event => void pick(profile, slot, event.target.value)}>
                  <option value="">Nowhere yet</option>
                  {PLUGINS.filter(p => p.slots.includes(slot)).flatMap(p => data.connections.filter(c => c.provider === p.provider)
                    .map(c => <option key={choice(p.id, c.id)} value={choice(p.id, c.id)}>{p.label} · {c.label}</option>))}
                </select>
                {current?.plugin === 'notion_database' && !open && <Button small look="quiet" disabled={act.busy}
                  onClick={() => setSetting({ profile, slot, connection: current.connection_id })}>Edit columns</Button>}
              </span>
              {current?.plugin === 'notion_database' && !open && <span className="fine muted">Files into {placeName(current)}</span>}
              {open && <NotionSetup profile={profile} slot={slot} connection={setting.connection}
                current={current?.plugin === 'notion_database' && current.connection_id === setting.connection ? current.settings : undefined}
                onCancel={() => setSetting(null)}
                onSaved={name => { setSetting(null); loaded.reload(); announce(`${PROFILE_LABEL[profile]} ${SLOT_LABEL[slot]} go to ${name}`); }} />}
            </li>;
          }))}
        </ul>
      </>}
      {act.error && <SaveError title="Nothing was changed." message={act.error} />}
      <p className="fine muted">Connecting lets Satchel add what you say yes to, and read the next week of a Google calendar
        and to-do list so it can place what you drop. On Notion it sees only the pages and databases you pick on Notion’s screen.</p>
    </div>
  </div>;
}
