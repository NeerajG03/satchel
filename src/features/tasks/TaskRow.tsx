import { Link } from 'react-router';
import type { TaskSummary } from './model';
import type { Project } from '../projects/repository';
import { projectScope, scopeName, scopeQuery } from '../../app/scope';
import { count } from '../../app/format';
import { StateChip } from '../../ui/Chip';
import { Provenance } from '../../ui/Provenance';

type Props = { task: TaskSummary; projects: Project[]; showScope?: boolean; parentTitle?: string };

export function TaskRow({ task, projects, showScope = false, parentTitle }: Props) {
  const scope = projectScope(task.project_id);
  const scopeText = scopeName(scope, projects);
  return <Link to={`/tasks/${task.id}${scopeQuery(scope)}`} className="entry task-row">
    <div className="between">
      <span className="serif" style={{ fontSize: 21, lineHeight: 1.25 }}>{task.title}</span>
      <StateChip status={task.status} />
    </div>
    <span>{task.next_action ? <>Next: {task.next_action}</> : <span className="muted">No next action yet.</span>}</span>
    {task.status === 'blocked' && task.blocked_reason && <span className="reason">Blocked: {task.blocked_reason}</span>}
    {task.blocked_by_ids.length > 0 && <span className="reason">Waiting on {count(task.blocked_by_ids.length, 'task')}</span>}
    <Provenance parts={[showScope && scopeText, task.priority, `rev ${task.revision}`, parentTitle && `child of ${parentTitle}`,
      task.child_count > 0 && count(task.child_count, 'child', 'children')]} at={task.last_activity_at} />
  </Link>;
}
