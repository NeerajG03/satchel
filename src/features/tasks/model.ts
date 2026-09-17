export type TaskStatus = 'inbox' | 'ready' | 'in_progress' | 'blocked' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type Task = {
  id: string;
  project_id: string | null;
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
  last_activity_at: string;
  closed_at: string | null;
};

export type TaskPlanning = Task & {
  parent_id: string | null;
  dependency_ids: string[];
  blocked_by_ids: string[];
  child_count: number;
  actionable: boolean;
};

export type TaskSummary = Pick<TaskPlanning,
  'id' | 'project_id' | 'title' | 'status' | 'priority' | 'next_action' |
  'blocked_reason' | 'revision' | 'updated_at' | 'last_activity_at' | 'parent_id' |
  'dependency_ids' | 'blocked_by_ids' | 'child_count' | 'actionable'>;

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

export type TaskUpdate = {
  id: string;
  task_id: string;
  kind: 'comment' | 'progress';
  body: string;
  completed: string[];
  decisions: string[];
  remaining: string[];
  blockers: string[];
  next_action: string | null;
  status: TaskStatus | null;
  blocked_reason: string;
  created_by: string;
  created_at: string;
};

export type TaskUpdateResourceRef = {
  update_id: string;
  resource_id: string;
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

export type TaskDetail = TaskPlanning & {
  handoffs: TaskHandoff[];
  updates: TaskUpdate[];
  resources: TaskResource[];
  update_resource_refs: TaskUpdateResourceRef[];
  events: TaskEvent[];
  scope_tasks: TaskSummary[];
};

export type TaskDraft = Pick<Task, 'title' | 'outcome' | 'why' | 'done_when' | 'next_action' | 'priority'>;
export const EMPTY_TASK: TaskDraft = {
  title: '', outcome: '', why: '', done_when: [], next_action: '', priority: 'medium',
};

export function taskSummary(task: Task&Partial<TaskPlanning>,previous?:TaskSummary): TaskSummary {
  const {id,project_id,title,status,priority,next_action,blocked_reason,revision,updated_at,last_activity_at}=task;
  return {id,project_id,title,status,priority,next_action,blocked_reason,revision,updated_at,last_activity_at,
    parent_id:task.parent_id??previous?.parent_id??null,
    dependency_ids:task.dependency_ids??previous?.dependency_ids??[],
    blocked_by_ids:task.blocked_by_ids??previous?.blocked_by_ids??[],
    child_count:task.child_count??previous?.child_count??0,
    actionable:task.actionable??previous?.actionable??false};
}

export function replaceTask(tasks: TaskSummary[], task: Task): TaskSummary[] {
  return [taskSummary(task,tasks.find(item=>item.id===task.id)),...tasks.filter(item=>item.id!==task.id)]
    .sort((a:TaskSummary,b:TaskSummary)=>b.last_activity_at.localeCompare(a.last_activity_at)||a.id.localeCompare(b.id));
}
