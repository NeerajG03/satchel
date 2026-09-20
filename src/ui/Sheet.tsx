import { useEffect, useRef, type ReactNode } from 'react';

type Props = { title: string; onClose: () => void; children: ReactNode; labelledBy?: string };

export function Sheet({ title, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    const opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); opener?.focus(); };
  }, []);
  return <dialog ref={ref} className="sheet" aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>;
}
