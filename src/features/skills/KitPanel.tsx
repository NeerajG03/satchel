import { pendingReasons, setupCommands, updateCommand, TARGET_LABELS, type Release, type Skill, type Target } from './model';

type Props = {
  target: Target; repository: string | null; ticked: Skill[]; release: Release | null;
  busy: boolean; onPublish: (target: Target) => void;
};

export function KitPanel({ target, repository, ticked, release, busy, onPublish }: Props) {
  const pending = pendingReasons(ticked, release);
  return <article>
    <div className="eyebrow">KIT · {TARGET_LABELS[target].toUpperCase()}</div>
    <p className="memory-description">
      {release ? `Published v${release.version}` : 'Never published'} · {ticked.length} skill{ticked.length === 1 ? '' : 's'} ticked
    </p>
    {pending.length > 0 && <div className="notice" role="status">
      <p className="fine">Not published yet:</p>
      <ul className="fine">{pending.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </div>}
    {pending.length === 0 && release && <p className="muted fine">
      This kit matches release v{release.version}.</p>}
    <div className="memory-meta">
      <span className="muted fine">
        {release?.commit_sha ? `Commit ${release.commit_sha.slice(0, 7)} · checksum ${release.checksum.slice(0, 12)}` : 'No release yet'}
      </span>
      <button className="primary" disabled={busy || !repository || ticked.length === 0 || pending.length === 0}
        onClick={() => onPublish(target)}>{busy ? 'Publishing…' : `Publish v${(release?.version ?? 0) + 1}`}</button>
    </div>

    {repository && <>
      <p className="muted fine">Set up once per machine:</p>
      {setupCommands(target, repository).map(command => <p key={command} className="memory-body"><code>{command}</code></p>)}
      <p className="muted fine">Then after each publish:</p>
      <p className="memory-body"><code>{updateCommand(target)}</code></p>
      {target === 'claude-code' && <p className="muted fine">
        A background marketplace refresh in Claude Code turns git credential helpers off, so a private HTTPS
        remote cannot refresh on its own. Use the SSH remote, or set
        <code> CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1</code>. The manual update above always
        authenticates normally.</p>}
    </>}

    <table><tbody>
      <tr><td className="fine">On the shelf</td><td className="fine">{ticked.length} ticked for this target</td></tr>
      <tr><td className="fine">In a published kit</td><td className="fine">
        {release ? `v${release.version}, ${release.manifest.skills.length} skill${release.manifest.skills.length === 1 ? '' : 's'}` : 'nothing yet'}</td></tr>
      <tr><td className="fine">Delivered to your agents</td><td className="fine muted">
        Not observable. GitHub serves the clone, so Satchel cannot see whether an agent fetched this.</td></tr>
      <tr><td className="fine">Able to run there</td><td className="fine muted">
        Not knowable from here. A skill with scripts needs its dependencies where it runs.</td></tr>
    </tbody></table>
  </article>;
}
