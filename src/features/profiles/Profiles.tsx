import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { Button } from '../../ui/Button';
import { ZONE } from '../settings/Overnight';
import { PROFILE_LABEL, type ProfileKind } from './repository';

/** Settings section: which topics are work and which are personal. */
export function Profiles() {
  const stores = useStores();
  const { announce } = useReadout();
  const loaded = useLoad(async () => {
    const [profiles, topics, tags, links] = await Promise.all([
      stores.profiles.list(), stores.topics.list(), stores.profiles.topicProfiles(), stores.google.links()]);
    return { profiles, topics: topics.filter(topic => !topic.merged_into), tags, links };
  }, [stores]);
  const save = useAction('action');
  const [tags, setTags] = useState<Record<string, ProfileKind>>({});
  useEffect(() => { if (loaded.data) setTags(loaded.data.tags); }, [loaded.data]);

  // A capture saying "Tuesday 3pm" needs the person's timezone. It is taken
  // from the browser once; after that it changes only when they say so, so a
  // laptop set to another zone cannot quietly move their events.
  const browserZone = ZONE();
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded.data) return;
    const saved = loaded.data.profiles[0]?.timezone ?? null;
    setZone(saved);
    if (!saved && browserZone) stores.profiles.setTimezone(browserZone).then(() => setZone(browserZone)).catch(() => {});
  }, [loaded.data, stores, browserZone]);

  async function useBrowserZone() {
    const done = await save.run(async () => { await stores.profiles.setTimezone(browserZone); return true; });
    if (done) { setZone(browserZone); announce(`Times are read in ${browserZone}`); }
  }

  async function tag(topicId: string, value: string) {
    const kind = value === '' ? null : value as ProfileKind;
    const done = await save.run(async () => { await stores.profiles.setTopicProfile(topicId, kind); return true; });
    if (!done) return;
    setTags(current => { const next = { ...current }; if (kind) next[topicId] = kind; else delete next[topicId]; return next; });
    announce(kind ? `Moved to ${PROFILE_LABEL[kind]}` : 'Taken out of both profiles');
  }

  const [linking, setLinking] = useState<ProfileKind | null>(null);
  const google = useAction('action');
  const location = useLocation();
  const linked = (location.state as { googleLinked?: string } | null)?.googleLinked;
  useEffect(() => { if (linked) announce(linked); }, [linked, announce]);

  async function link(kind: ProfileKind) {
    setLinking(kind);
    await google.run(() => stores.google.start(kind));
    setLinking(null);
  }
  async function unlink(kind: ProfileKind) {
    setLinking(kind);
    const done = await google.run(async () => { await stores.google.unlink(kind); return true; });
    setLinking(null);
    if (done) { loaded.reload(); announce(`${PROFILE_LABEL[kind]} is no longer linked to Google`); }
  }

  return <div className="settings-row">
    <h2>Profiles</h2>
    <div className="stack-tight">
      <p className="muted">Work and Personal. Each topic belongs to one, and so does everything on your Shelf,
        so a to-do lands in the right calendar and list.</p>
      {loaded.data && <ul className="profile-google">
        {(['personal', 'work'] as ProfileKind[]).map(kind => {
          const account = loaded.data!.links.find(l => l.profile === kind);
          return <li key={kind}>
            <span><strong>{PROFILE_LABEL[kind]}</strong> <span className="muted">· {account
              ? <>Google: {account.email}</> : 'no Google account linked'}</span></span>
            {account
              ? <Button small look="quiet" disabled={google.busy} onClick={() => void unlink(kind)}>{linking === kind ? 'Unlinking…' : 'Unlink'}</Button>
              : <Button small disabled={google.busy} onClick={() => void link(kind)}>{linking === kind ? 'Opening Google…' : 'Link Google account'}</Button>}
          </li>;
        })}
      </ul>}
      {google.error && <SaveError title="Google was not changed." message={google.error} />}
      <p className="fine muted">Linking lets Satchel add the to-dos and events you say yes to, and read the next week of that
        calendar and to-do list so it can place what you drop. Nothing is added without you.</p>
      {loaded.error && <LoadError what="Your profiles" message={loaded.error} onReload={loaded.reload} />}
      {loaded.loading && !loaded.data && <Skeleton rows={2} />}
      {loaded.data && loaded.data.topics.length === 0 && <p className="fine muted">You have no topics yet. New ones can be tagged here.</p>}
      {loaded.data && loaded.data.topics.length > 0 && <ul className="profile-topics">
        {loaded.data.topics.map(topic => <li key={topic.id}>
          <label htmlFor={`profile-${topic.id}`}>{topic.name}</label>
          <select id={`profile-${topic.id}`} className="field" value={tags[topic.id] ?? ''} disabled={save.busy}
            onChange={event => void tag(topic.id, event.target.value)}>
            <option value="">Not set</option>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
          </select>
        </li>)}
      </ul>}
      {zone && <p className="fine muted">Times in your captures are read in {zone}.
        {browserZone && zone !== browserZone && <> <Button look="link" small disabled={save.busy}
          onClick={() => void useBrowserZone()}>Use {browserZone} instead</Button></>}</p>}
      {save.error && <SaveError title="Could not change the profile." message={save.error} />}
    </div>
  </div>;
}
