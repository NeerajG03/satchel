import { useCallback, useEffect, useRef, useState } from 'react';
import { explain, type Operation } from '../client';

export type Loaded<T> = {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => void;
  replace: (update: (current: T) => T) => void;
};

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    latest.current().then(result => { if (active) setData(result); })
      .catch(async reason => { const text = await explain(reason, 'load'); if (active) setError(text); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick(value => value + 1), []);
  const replace = useCallback((update: (current: T) => T) => setData(current => current === null ? current : update(current)), []);
  return { data, error, loading, reload, replace };
}

/** `operation` picks the fallback wording: 'save' for a form that keeps a
 *  draft, 'action' for a button with nothing typed to keep. */
export function useAction(operation: Operation = 'save') {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setError('');
    try { return await action(); }
    catch (reason) { setError(await explain(reason, operation)); return undefined; }
    finally { setBusy(false); }
  }
  return { busy, error, run, clear: () => setError('') };
}

export function isConflict(reason: unknown): boolean {
  const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : '';
  return code === 'PT409' || code === '40001';
}
