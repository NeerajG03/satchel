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
// What a memory is, which decides how long it lives and what may happen to it.
// A fact is true until something makes it false and nothing can retire it. A
// preference gets stronger every time it is said again. An intent is something
// wanted but not true yet, and it is the only kind consolidation may retire,
// when the person says it is done.
export type MemoryKind = 'fact' | 'preference' | 'intent';
export const KINDS: { value: MemoryKind; label: string; hint: string }[] = [
  { value: 'fact', label: 'How things are', hint: 'true until something makes it false' },
  { value: 'preference', label: 'How you like things', hint: 'gets stronger each time you say it' },
  { value: 'intent', label: 'Something you want', hint: 'ends when it is done' },
];
export const kindLabel = (kind: MemoryKind | string) =>
  KINDS.find(k => k.value === kind)?.label ?? String(kind);

export type MemoryContent = { statement: string; name: string; more_info: string; kind: MemoryKind };
export const EMPTY_CONTENT: MemoryContent = { statement: '', name: '', more_info: '', kind: 'fact' };
export const MEMORY_LIMITS = { statement: 500, name: 100, more_info: 40000 } as const;

// A memory has one scope, and it is a project or personal. There was a
// task_id here too; it is gone, along with the only way a wrong guess about a
// task could move a memory into a project nobody named.
export type MemorySummary = {
  id: string; project_id: string | null; statement: string; band: MemoryBand;
  kind: MemoryKind; mentions: number; name: string | null; has_more_info: boolean;
  revision: number; updated_at: string;
};

/** A memory that has stopped loading, and why. Ended is a decision someone
 *  made; expired is a deadline passing, so `ended_at` is null on those. */
export type ArchivedMemory = {
  id: string; project_id: string | null; statement: string; band: MemoryBand; kind: MemoryKind;
  ended_at: string | null; ended_reason: 'replaced' | 'retired' | 'forgotten' | null;
  ended_by: string | null; ended_note: string | null;
  expires_at: string | null; revision: number; updated_at: string;
};
export const ENDED_WORD: Record<string, string> = {
  replaced: 'Replaced by a newer one', retired: 'Done, so it was retired',
  forgotten: 'You forgot it', expired: 'Its date passed',
};
export const endedWhy = (memory: ArchivedMemory) => ENDED_WORD[memory.ended_reason ?? 'expired'] ?? 'Archived';
export type Memory = MemorySummary & { source: string; more_info: string; created_at: string };

// Six characters is what the agent sees, so it is what the user should see when
// they want to talk about a particular row.
export const handleOf = (id: string) => id.replace(/-/g, '').slice(0, 6);

export function memorySummary(memory: Memory): MemorySummary {
  const { id, project_id, statement, band, kind, mentions, name, revision, updated_at } = memory;
  return { id, project_id, statement, band, kind, mentions, name, revision, updated_at,
    has_more_info: Boolean(memory.more_info?.trim()) };
}

export function replaceSummary(memories: MemorySummary[], memory: Memory): MemorySummary[] {
  return [...memories.filter(item => item.id !== memory.id), memorySummary(memory)]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}
