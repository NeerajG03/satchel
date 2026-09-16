export type TaskStatus = 'inbox' | 'ready' | 'in_progress' | 'blocked' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type Task = {
  id: string;
  project_id: string;
  title: string;
  outcome: string;
  why: string;
  done_when: string[];
  next_action: string;
  status: TaskStatus;
  priority: TaskPriority;
  blocked_reason: string;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type TaskSummary = Pick<Task,
  'id' | 'project_id' | 'title' | 'status' | 'priority' | 'next_action' |
  'blocked_reason' | 'revision' | 'updated_at'>;

export type TaskResource = {
  id: string;
  task_id: string;
  kind: 'storage_object' | 'external_url';
  resource_type: 'reference' | 'document' | 'image' | 'artifact' | 'repository' | 'pull_request';
  label: string;
  external_url: string | null;
  external_provider: string | null;
  object_key: string | null;
  original_filename: string | null;
  media_type: string | null;
  expected_bytes: number | null;
  checksum_sha256: string | null;
  upload_status: 'pending' | 'uploaded' | 'verified' | 'failed' | 'deleted';
  failure_reason: string | null;
  created_at: string;
};

export type TaskHandoff = {
  id: string;
  task_id: string;
  supersedes_ids: string[];
  completed: string[];
  decisions: string[];
  validation: Record<string, unknown>[];
  remaining: string[];
  blockers: string[];
  next_action: string;
  summary: string;
  created_by: string;
  created_at: string;
};

export type TaskEvent = {
  id: number;
  event_type: string;
  from_revision: number | null;
  to_revision: number;
  details: Record<string, unknown>;
  created_by: string;
  created_at: string;
};

export type TaskDetail = Task & {
  handoffs: TaskHandoff[];
  resources: TaskResource[];
  events: TaskEvent[];
};

export type TaskDraft = Pick<Task, 'title' | 'outcome' | 'why' | 'done_when' | 'next_action' | 'priority'>;
export const EMPTY_TASK: TaskDraft = {
  title: '', outcome: '', why: '', done_when: [], next_action: '', priority: 'medium',
};

export function taskSummary(task: Task): TaskSummary {
  const {id,project_id,title,status,priority,next_action,blocked_reason,revision,updated_at}=task;
  return {id,project_id,title,status,priority,next_action,blocked_reason,revision,updated_at};
}

export function replaceTask(tasks: TaskSummary[], task: Task): TaskSummary[] {
  return [taskSummary(task),...tasks.filter(item=>item.id!==task.id)]
    .sort((a:TaskSummary,b:TaskSummary)=>b.updated_at.localeCompare(a.updated_at)||a.id.localeCompare(b.id));
}
