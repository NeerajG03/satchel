import { PERSONAL_SCOPE, type MemoryScope } from '../features/memories/model';
import type { Project } from '../features/projects/repository';

export function parseScope(value: string | null): MemoryScope {
  // project: is what links said before topics; they still open the topic.
  const match = value?.match(/^(?:topic|project):(.+)$/);
  if (match) return { kind: 'project', projectId: match[1] };
  return PERSONAL_SCOPE;
}

export function scopeParam(scope: MemoryScope): string | null {
  return scope.kind === 'project' ? `topic:${scope.projectId}` : null;
}

export function scopeQuery(scope: MemoryScope, extra: Record<string, string | null> = {}): string {
  const params = new URLSearchParams();
  const value = scopeParam(scope);
  if (value) params.set('scope', value);
  for (const [key, entry] of Object.entries(extra)) if (entry) params.set(key, entry);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function scopeName(scope: MemoryScope, projects: Project[]): string {
  if (scope.kind === 'personal') return 'For me';
  return projects.find(project => project.id === scope.projectId)?.name ?? 'Topic';
}

export function scopeEyebrow(scope: MemoryScope, projects: Project[]): string {
  return scope.kind === 'personal' ? 'For me' : `Topic · ${scopeName(scope, projects)}`;
}

export function projectScope(projectId: string | null): MemoryScope {
  return projectId ? { kind: 'project', projectId } : PERSONAL_SCOPE;
}

export function scopeProjectIdOf(scope: MemoryScope): string | null {
  return scope.kind === 'project' ? scope.projectId : null;
}
