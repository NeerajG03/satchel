import { TARGETS, TARGET_LABELS, type KitItem, type Skill, type SkillSource, type Target } from './model';

type Props = {
  sources: SkillSource[]; skills: Skill[]; kit: KitItem[]; busy: boolean;
  onToggle: (target: Target, skill: Skill, included: boolean) => void;
  onSync: (source: SkillSource) => void;
};

export function SkillShelf({ sources, skills, kit, busy, onToggle, onSync }: Props) {
  const ticked = (target: Target, id: string) => kit.some(item => item.target === target && item.skill_id === id);
  return <div>
    {sources.map(source => {
      const owned = skills.filter(skill => skill.source_id === source.id);
      return <article key={source.id}>
        <h2 className="memory-name">{source.repository}</h2>
        <p className="memory-description">
          {source.is_delivery_target ? 'Your skills, and where Satchel publishes. ' : 'A source Satchel only reads. '}
          {owned.length} skill{owned.length === 1 ? '' : 's'}
        </p>
        <div className="memory-meta">
          <span className="muted fine">
            {source.commit_sha ? `Read at ${source.commit_sha.slice(0, 7)}` : 'Never read'}
            {source.synced_at ? ` · ${new Date(source.synced_at).toLocaleString()}` : ''}
          </span>
          <button className="quiet" disabled={busy} onClick={() => onSync(source)}>Sync</button>
        </div>
        {owned.length === 0 && <p className="muted fine">
          Nothing found. Satchel reads <code>skills/&lt;name&gt;/SKILL.md</code> only, so a skill needs its own
          directory there. Commit one and sync.</p>}
        {owned.map(skill => <div key={skill.id} className="notice">
          <h2 className="memory-name">{skill.name}</h2>
          <p className="memory-description">{skill.description || 'No description in its frontmatter.'}</p>
          {TARGETS.map(target => <label className="choice" key={target}>
            <input type="checkbox" disabled={busy} checked={ticked(target, skill.id)}
              onChange={event => onToggle(target, skill, event.target.checked)} />
            {TARGET_LABELS[target]}
          </label>)}
          <p className="muted fine">
            <code>{skill.path}</code>
            {skill.changed && ' · newer in the repository, sync to pick it up'}
          </p>
        </div>)}
      </article>;
    })}
  </div>;
}
