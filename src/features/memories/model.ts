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

// A memory is one sentence. `source` is what the user actually typed and is
// kept for provenance; it is never shown to an agent. `band` records whether
// the user confirmed it or it was picked up in passing.
export type MemoryBand = 'said' | 'heard';
export type MemoryContent = { statement: string; name: string; more_info: string };
export const EMPTY_CONTENT: MemoryContent = { statement: '', name: '', more_info: '' };
export const MEMORY_LIMITS = { statement: 500, name: 100, more_info: 40000 } as const;

// A memory has one scope, and it is a project or personal. There was a
// task_id here too; it is gone, along with the only way a wrong guess about a
// task could move a memory into a project nobody named.
export type MemorySummary = {
  id: string; project_id: string | null; statement: string; band: MemoryBand;
  name: string | null; has_more_info: boolean;
  revision: number; updated_at: string;
};
export type Memory = MemorySummary & { source: string; more_info: string; created_at: string };

// Six characters is what the agent sees, so it is what the user should see when
// they want to talk about a particular row.
export const handleOf = (id: string) => id.replace(/-/g, '').slice(0, 6);

export function memorySummary(memory: Memory): MemorySummary {
  const { id, project_id, statement, band, name, revision, updated_at } = memory;
  return { id, project_id, statement, band, name, revision, updated_at,
    has_more_info: Boolean(memory.more_info?.trim()) };
}

export function replaceSummary(memories: MemorySummary[], memory: Memory): MemorySummary[] {
  return [...memories.filter(item => item.id !== memory.id), memorySummary(memory)]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}
