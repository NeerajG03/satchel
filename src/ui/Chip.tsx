import type { TaskStatus } from '../features/tasks/model';
import { stateWord } from '../app/format';

const LOOK: Record<TaskStatus, string> = { inbox: '', ready: 'ink', in_progress: 'progress', blocked: 'blocked', done: 'done' };

export function Chip({ children, look = '' }: { children: string; look?: string }) {
  return <span className={`chip ${look}`.trim()}>{children}</span>;
}

export function StateChip({ status }: { status: TaskStatus }) {
  return <Chip look={LOOK[status]}>{stateWord(status)}</Chip>;
}
