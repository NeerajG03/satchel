import { useEffect, useState } from 'react';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { PROFILE_LABEL, type ProfileKind } from './repository';

/** Settings section: which topics are work and which are personal. */
export function Profiles() {
  const stores = useStores();
  const { announce } = useReadout();
  const loaded = useLoad(async () => {
    const [profiles, topics, tags] = await Promise.all([
      stores.profiles.list(), stores.topics.list(), stores.profiles.topicProfiles()]);
    return { profiles, topics: topics.filter(topic => !topic.merged_into), tags };
  }, [stores]);
  const save = useAction('action');
  const [tags, setTags] = useState<Record<string, ProfileKind>>({});
  useEffect(() => { if (loaded.data) setTags(loaded.data.tags); }, [loaded.data]);

  // The browser knows the person's timezone; a capture saying "Tuesday 3pm" needs it.
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (loaded.data && zone && loaded.data.profiles.some(p => p.timezone !== zone))
      stores.profiles.setTimezone(zone).catch(() => {});
  }, [loaded.data, stores]);

  async function tag(topicId: string, value: string) {
    const kind = value === '' ? null : value as ProfileKind;
    const done = await save.run(async () => { await stores.profiles.setTopicProfile(topicId, kind); return true; });
    if (!done) return;
    setTags(current => { const next = { ...current }; if (kind) next[topicId] = kind; else delete next[topicId]; return next; });
    announce(kind ? `Moved to ${PROFILE_LABEL[kind]}` : 'Taken out of both profiles');
  }

  return <div className="settings-row">
    <h2>Profiles</h2>
    <div className="stack-tight">
      <p className="muted">Work and Personal. Each topic belongs to one, and so does everything on your Shelf,
        so a to-do lands in the right calendar and list.</p>
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
      {save.error && <SaveError title="Could not change the profile." message={save.error} />}
    </div>
  </div>;
}
