import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Menu({ label, children, disabled }: { label: string; children: (close: () => void) => ReactNode; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function away(event: MouseEvent) { if (!ref.current?.contains(event.target as Node)) setOpen(false); }
    function key(event: KeyboardEvent) { if (event.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className="menu" ref={ref}>
    <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}>{label} ▾</button>
    {open && <div className="drop" role="menu">{children(() => setOpen(false))}</div>}
  </div>;
}
