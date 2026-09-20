import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type Light = 'green' | 'amber' | 'red' | 'off';
type Readout = {
  left: string;
  message: string;
  status: { light: Light; word: string };
  setLeft: (text: string) => void;
  announce: (text: string) => void;
  setStatus: (light: Light, word: string) => void;
};

const ReadoutContext = createContext<Readout | null>(null);
const DEFAULT_STATUS = { light: 'green' as Light, word: 'Synced' };

export function ReadoutProvider({ children }: { children: ReactNode }) {
  const [left, setLeft] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatusState] = useState(DEFAULT_STATUS);
  const announce = useCallback((text: string) => setMessage(text), []);
  const setStatus = useCallback((light: Light, word: string) => setStatusState({ light, word }), []);
  const value = useMemo(() => ({ left, message, status, setLeft, announce, setStatus }), [left, message, status, announce, setStatus]);
  return <ReadoutContext.Provider value={value}>{children}</ReadoutContext.Provider>;
}

export function useReadout(): Readout {
  const value = useContext(ReadoutContext);
  if (!value) throw new Error('useReadout needs ReadoutProvider');
  return value;
}

export function useFooter(left: string, status?: { light: Light; word: string }) {
  const { setLeft, setStatus, announce } = useReadout();
  useEffect(() => { setLeft(left); }, [left, setLeft]);
  useEffect(() => {
    const next = status ?? DEFAULT_STATUS;
    setStatus(next.light, next.word);
  }, [status?.light, status?.word, setStatus]);
  useEffect(() => () => announce(''), [announce]);
}
