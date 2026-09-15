import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorMessage } from './client';
import { createSkillRepository } from './features/skills/repository';
import { normalizeRepository, TARGETS, type Delivery, type KitItem, type Release, type Skill, type SkillSource, type Target } from './features/skills/model';
import { DeliverySetup } from './features/skills/DeliverySetup';
import { SkillShelf } from './features/skills/SkillShelf';
import { KitPanel } from './features/skills/KitPanel';

export function Shelf({ db, slug, installationId }: { db: SupabaseClient; slug: string; installationId?: number }) {
  const store = useMemo(() => createSkillRepository(db), [db]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [kit, setKit] = useState<KitItem[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [extraRepository, setExtraRepository] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError('');
    Promise.all([store.sources(), store.skills(), store.kit(), store.releases(), store.delivery()])
      .then(([loadedSources, loadedSkills, loadedKit, loadedReleases, loadedDelivery]) => {
        if (!active) return;
        setSources(loadedSources); setSkills(loadedSkills); setKit(loadedKit);
        setReleases(loadedReleases); setDelivery(loadedDelivery);
      })
      .catch(cause => { if (active) setLoadError(errorMessage(cause, 'load')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [store, refresh]);

  async function run(action: () => Promise<string>): Promise<boolean> {
    setBusy(true); setError(''); setNotice(''); setWarnings([]);
    try { setNotice(await action()); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : errorMessage(cause)); return false; }
    finally { setBusy(false); }
  }
  const reload = () => setRefresh(value => value + 1);

  const connect = (repository: string, id: number) => run(async () => {
    await store.connect(repository, id);
    // The delivery repository is also the user's own skills source, so it goes
    // on the shelf in the same action rather than needing a second step.
    if (!sources.some(source => source.repository === repository))
      await store.addSource(crypto.randomUUID(), repository, true);
    reload();
    return `Connected ${repository}. Sync it to read your skills.`;
  });

  const addSource = (event: FormEvent) => {
    event.preventDefault();
    const repository = normalizeRepository(extraRepository);
    if (!repository) { setError('Enter a GitHub repository as owner/name or a GitHub URL.'); return; }
    void run(async () => {
      await store.addSource(crypto.randomUUID(), repository, false);
      setExtraRepository(''); reload();
      return `Added ${repository}. Sync it to read its skills.`;
    });
  };

  const sync = (source: SkillSource) => void run(async () => {
    const result = await store.sync(source.id);
    reload();
    if (result.empty) return `${source.repository} has no commits yet.`;
    const extra: string[] = [];
    if (result.truncated) extra.push('Its tree was truncated, so this list may be incomplete.');
    setWarnings([...(result.warnings ?? []), ...extra]);
    return `Read ${result.synced} skill${result.synced === 1 ? '' : 's'} from ${source.repository}.`;
  });

  const toggle = (target: Target, skill: Skill, included: boolean) => {
    setKit(items => included
      ? [...items, { target, skill_id: skill.id }]
      : items.filter(item => !(item.target === target && item.skill_id === skill.id)));
    void run(async () => {
      await store.setKitItem(target, skill.id, included);
      return `${included ? 'Added' : 'Removed'} ${skill.name} ${included ? 'to' : 'from'} the ${target} kit. Publish to send it.`;
    }).then(ok => { if (!ok) reload(); });
  };

  const publish = (target: Target) => void run(async () => {
    const { release } = await store.publish(target);
    reload();
    const removed = release.removed.length ? ` Removed ${release.removed.length} generated file${release.removed.length === 1 ? '' : 's'}.` : '';
    return `Published ${target} v${release.version} as ${release.commit_sha.slice(0, 7)}.${removed} Run the update command in that agent to pick it up.`;
  });

  const latest = (target: Target): Release | null =>
    releases.filter(release => release.target === target).sort((a, b) => b.version - a.version)[0] ?? null;
  const tickedFor = (target: Target) =>
    skills.filter(skill => kit.some(item => item.target === target && item.skill_id === skill.id));

  return <div className="book-layout">
    <aside>
      <div className="eyebrow">YOUR SKILLS</div>
      <p className="muted fine">A skill lives in a repository. Satchel chooses which ones each agent gets,
        and never stores the skill itself.</p>
      {delivery && !delivery.revoked_at && <>
        <div className="eyebrow scope-label">ADD A SOURCE</div>
        <form onSubmit={addSource}>
          <label>Repository to read<input value={extraRepository} disabled={busy} placeholder="vercel-labs/agent-skills"
            onChange={event => setExtraRepository(event.target.value)} /></label>
          <button disabled={busy || !extraRepository.trim()}>Add source</button>
        </form>
        <p className="muted fine">Satchel only reads an added source. It never writes to it.</p>
      </>}
    </aside>

    <section className="book">
      <div className="book-heading">
        <div><div className="eyebrow">THE SHELF</div><h1>Your skills.</h1></div>
        <button className="quiet" disabled={busy || loading} onClick={() => { setError(''); setNotice(''); reload(); }}>Reload</button>
      </div>

      {loadError && <p role="alert" className="notice error">{loadError}</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {warnings.length > 0 && <div className="notice" role="status">
        <p className="fine">Worth knowing:</p>
        <ul className="fine">{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      </div>}

      <DeliverySetup delivery={delivery} slug={slug} busy={busy} installationId={installationId} onConnect={connect} />

      {loading ? <p role="status">Opening the shelf…</p> : <>
        {sources.length === 0 && delivery && !delivery.revoked_at && <div className="empty">
          <h2>Nothing on the shelf yet.</h2>
          <p>Commit a skill to <code>skills/&lt;name&gt;/SKILL.md</code> in your repository, then sync.</p>
        </div>}
        <SkillShelf sources={sources} skills={skills} kit={kit} busy={busy} onToggle={toggle} onSync={sync} />
        {sources.length > 0 && TARGETS.map(target => <KitPanel key={target} target={target}
          repository={delivery && !delivery.revoked_at ? delivery.repository : null}
          ticked={tickedFor(target)} release={latest(target)} busy={busy} onPublish={publish} />)}
      </>}
    </section>
  </div>;
}
