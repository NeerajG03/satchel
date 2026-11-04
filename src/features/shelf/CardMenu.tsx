import { useEffect, useRef, useState, type ReactNode } from 'react';

/** The ⋯ on a card: the things done now and then, kept off the shelf until asked for. */
export function CardMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="card-menu" ref={box}>
    <button type="button" className="icon-key" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
    </button>
    {open && <div className="card-menu-panel" role="group" aria-label={label}>{children(() => setOpen(false))}</div>}
  </div>;
}
