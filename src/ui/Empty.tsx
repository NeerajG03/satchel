import type { ReactNode } from 'react';

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty">
    <h2>{title}</h2>
    {children && <p className="muted">{children}</p>}
    {action}
  </div>;
}
