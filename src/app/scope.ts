import { PERSONAL_SCOPE, type MemoryScope } from '../features/memories/model';
import type { Topic } from '../features/topics/repository';

export function parseScope(value: string | null): MemoryScope {
  // topic: is what links said before topics; they still open the topic.
  const match = value?.match(/^(?:topic|topic):(.+)$/);
  if (match) return { kind: 'topic', topicId: match[1] };
  return PERSONAL_SCOPE;
}

export function scopeParam(scope: MemoryScope): string | null {
  return scope.kind === 'topic' ? `topic:${scope.topicId}` : null;
}

export function scopeQuery(scope: MemoryScope, extra: Record<string, string | null> = {}): string {
  const params = new URLSearchParams();
  const value = scopeParam(scope);
  if (value) params.set('scope', value);
  for (const [key, entry] of Object.entries(extra)) if (entry) params.set(key, entry);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function scopeName(scope: MemoryScope, topics: Topic[]): string {
  if (scope.kind === 'personal') return 'For me';
  return topics.find(topic => topic.id === scope.topicId)?.name ?? 'Topic';
}

export function scopeEyebrow(scope: MemoryScope, topics: Topic[]): string {
  return scope.kind === 'personal' ? 'For me' : `Topic · ${scopeName(scope, topics)}`;
}

export function topicScope(topicId: string | null): MemoryScope {
  return topicId ? { kind: 'topic', topicId } : PERSONAL_SCOPE;
}

export function scopeTopicIdOf(scope: MemoryScope): string | null {
  return scope.kind === 'topic' ? scope.topicId : null;
}
