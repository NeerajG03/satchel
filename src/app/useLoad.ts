import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../client';

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
      .catch(reason => { if (active) setError(errorMessage(reason, 'load')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick(value => value + 1), []);
  const replace = useCallback((update: (current: T) => T) => setData(current => current === null ? current : update(current)), []);
  return { data, error, loading, reload, replace };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setError('');
    try { return await action(); }
    catch (reason) { setError(errorMessage(reason)); return undefined; }
    finally { setBusy(false); }
  }
  return { busy, error, run, clear: () => setError('') };
}

export function isConflict(reason: unknown): boolean {
  const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : '';
  return code === 'PT409' || code === '40001';
}
