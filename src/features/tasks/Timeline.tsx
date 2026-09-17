import type { TaskDetail, TaskHandoff, TaskUpdate } from './model';
import type { Connection } from '../connections/repository';
import { actorLabel, stateWord } from '../../app/format';
import { Provenance } from '../../ui/Provenance';
import { StateChip } from '../../ui/Chip';

type Item = { id: string; at: string; kind: 'handoff'; handoff: TaskHandoff } | { id: string; at: string; kind: 'update'; update: TaskUpdate };

function Rows({ rows }: { rows: [string, string[] | string | null | undefined][] }) {
  const present = rows.filter(([, value]) => Array.isArray(value) ? value.length > 0 : Boolean(value));
  if (present.length === 0) return null;
  return <dl className="rows">{present.map(([label, value]) => <div key={label} style={{ display: 'contents' }}>
    <dt>{label}</dt><dd>{Array.isArray(value) ? value.join(' · ') : value}</dd></div>)}</dl>;
}

export function timelineItems(task: TaskDetail): Item[] {
  return [
    ...task.updates.map(update => ({ kind: 'update' as const, id: update.id, at: update.created_at, update })),
    ...task.handoffs.map(handoff => ({ kind: 'handoff' as const, id: handoff.id, at: handoff.created_at, handoff })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

export function Timeline({ task, apps }: { task: TaskDetail; apps: Connection[] }) {
  const items = timelineItems(task);
  const linked = (updateId: string) => task.update_resource_refs.filter(ref => ref.update_id === updateId)
    .map(ref => task.resources.find(resource => resource.id === ref.resource_id)?.label).filter(Boolean) as string[];
  if (items.length === 0) return <p className="muted">No activity yet. The first comment, progress update or handoff shows here.</p>;
  return <div className="timeline">{items.map(item => item.kind === 'update' ? <article className="entry" key={item.id}>
    <div className="between">
      <span className="eyebrow">{item.update.kind === 'progress' ? 'Progress update' : 'Comment'}</span>
      {item.update.status && <StateChip status={item.update.status} />}
    </div>
    <p className="desc">{item.update.body}</p>
    <Rows rows={[['Completed', item.update.completed], ['Decisions', item.update.decisions], ['Remaining', item.update.remaining],
      ['Blockers', item.update.blockers], ['Next', item.update.next_action], ['Resources', linked(item.update.id)]]} />
    <Provenance parts={[`by ${actorLabel(item.update.created_by, apps)}`, item.update.status && `moved to ${stateWord(item.update.status).toLowerCase()}`]} at={item.update.created_at} />
  </article> : <article className="entry" key={item.id}>
    <div className="between"><span className="eyebrow">Handoff</span></div>
    {item.handoff.summary && <p className="desc">{item.handoff.summary}</p>}
    <Rows rows={[['Completed', item.handoff.completed], ['Validated', item.handoff.validation.map(v => String(v.note ?? JSON.stringify(v)))],
      ['Decisions', item.handoff.decisions], ['Remaining', item.handoff.remaining], ['Blockers', item.handoff.blockers], ['Next', item.handoff.next_action]]} />
    <Provenance parts={[`by ${actorLabel(item.handoff.created_by, apps)}`, item.handoff.supersedes_ids.length > 0 && 'supersedes an earlier handoff']} at={item.handoff.created_at} />
  </article>)}</div>;
}
