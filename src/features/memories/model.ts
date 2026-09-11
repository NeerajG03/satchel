export type MemoryScope = { kind: 'personal' } | { kind: 'project'; projectId: string };
export const PERSONAL_SCOPE: MemoryScope = { kind: 'personal' };

// Only this boundary maps application scopes to the current database shape.
export function scopeProjectId(scope: MemoryScope): string | null {
  switch (scope.kind) {
    case 'personal': return null;
    case 'project': return scope.projectId;
    default: {
      const unsupported: never = scope;
      throw new Error(`Unsupported memory scope: ${unsupported}`);
    }
  }
}

export type MemoryContent = { name: string; description: string; more_info: string };
export const EMPTY_CONTENT: MemoryContent = { name: '', description: '', more_info: '' };
export const MEMORY_LIMITS = { name: 100, description: 280, more_info: 40000 } as const;
export type MemorySummary = {
  id: string; project_id: string | null; name: string; description: string;
  revision: number; updated_at: string;
};
export type Memory = MemorySummary & { more_info: string; created_at: string };

export function memorySummary(memory: Memory): MemorySummary {
  const { id, project_id, name, description, revision, updated_at } = memory;
  return { id, project_id, name, description, revision, updated_at };
}

export function replaceSummary(memories: MemorySummary[], memory: Memory): MemorySummary[] {
  return [...memories.filter(item => item.id !== memory.id), memorySummary(memory)]
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
}
