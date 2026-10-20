const DAY = 86_400_000;

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function whenText(iso: string, now = Date.now()): string {
  const then = new Date(iso);
  const diff = now - then.getTime();
  const time = then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (new Date(now).toDateString() === then.toDateString()) return `today ${time}`;
  if (new Date(now - DAY).toDateString() === then.toDateString()) return `yesterday ${time}`;
  if (diff < 6 * DAY) return then.toLocaleDateString(undefined, { weekday: 'short' });
  return shortDate(iso);
}

export function todayLine(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function actorLabel(actor: string, apps: { client_id: string; label: string }[] = []): string {
  if (actor.startsWith('user:')) return 'you';
  if (actor.startsWith('agent:')) {
    const id = actor.slice('agent:'.length);
    return apps.find(app => app.client_id === id)?.label ?? id;
  }
  return actor;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function stateWord(status: string): string {
  const words = status.replace('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
