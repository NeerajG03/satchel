import { useStores } from '../../app/stores';
import { useLoad } from '../../app/useLoad';
import { PROFILE_LABEL, type ProfileKind } from '../profiles/repository';
import type { Upcoming } from '../profiles/google';
import { LinkButton } from '../../ui/Button';
import { LoadError, Skeleton } from '../../ui/Notice';

function whenOf(item: Upcoming): string {
  if (item.at) {
    const at = new Date(item.at);
    return `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}, ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  // A day with no time is a calendar day: read it at noon so no zone moves it.
  if (item.day) return new Date(`${item.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return 'No date';
}

/** The next seven days from the person's linked Google accounts, so the Shelf sits beside their week. */
export function ComingUp({ profile }: { profile: ProfileKind | 'all' }) {
  const stores = useStores();
  const week = useLoad(() => stores.google.upcoming(), [stores]);
  const items = (week.data?.items ?? []).filter(i => profile === 'all' || i.profile === profile);
  const linked = week.data?.linked ?? [];
  const unlinked = profile !== 'all' && week.data && !linked.includes(profile);

  return <section className="shelf-panel" aria-labelledby="coming-up-title">
    <div className="shelf-panel-head">
      <h2 id="coming-up-title">Coming up</h2>
      <span className="eyebrow">Next 7 days · from Google</span>
    </div>
    {week.loading && !week.data && <Skeleton rows={3} />}
    {week.error && <LoadError what="Your week" message={week.error} onReload={week.reload} />}
    {week.data && (linked.length === 0 || unlinked)
      ? <p className="fine muted">Link a Google account to {unlinked ? PROFILE_LABEL[profile as ProfileKind] : 'Work or Personal'} to see
        your calendar and open tasks here. <LinkButton look="link" small to="/settings">Settings</LinkButton></p>
      : week.data && items.length === 0 && <p className="fine muted">Nothing on your calendar or tasks in the next seven days.</p>}
    {(week.data?.failed ?? []).filter(p => profile === 'all' || p === profile).map(p =>
      <p key={p} className="fine" role="status">Google did not answer for {PROFILE_LABEL[p]}, so it is not shown. Reload to try again.</p>)}
    {items.length > 0 && <ul className="coming-up">{items.map((item, n) => <li key={`${item.profile}-${n}`}>
      <span className="mono when">{whenOf(item)}</span>
      <span className="what">{item.kind === 'task' && <span className="muted">Task · </span>}
        {item.link ? <a href={item.link} target="_blank" rel="noreferrer">{item.title}</a> : item.title}</span>
      {profile === 'all' && <span className="eyebrow">{PROFILE_LABEL[item.profile]}</span>}
    </li>)}</ul>}
  </section>;
}
