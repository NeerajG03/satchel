import type { ReactNode } from 'react';

type Props = { title?: string; children?: ReactNode; actions?: ReactNode; look?: 'error' | 'amber' | 'plain' };

export function Notice({ title, children, actions, look = 'plain' }: Props) {
  return <div className={`notice ${look === 'plain' ? '' : look}`.trim()} role={look === 'error' ? 'alert' : undefined}>
    {title && <strong>{title}</strong>}
    {children && <div>{children}</div>}
    {actions && <div className="actions">{actions}</div>}
  </div>;
}

export function LoadError({ what, onReload }: { what: string; onReload: () => void }) {
  return <Notice look="error" title="Couldn’t reach your Satchel."
    actions={<button type="button" className="btn sm" onClick={onReload}>Reload</button>}>
    {what} didn’t load. Nothing is lost. Your apps keep whatever they already read.
  </Notice>;
}

export function SaveError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Notice look="error" title="Could not save."
    actions={onRetry && <button type="button" className="btn sm" onClick={onRetry}>Try again</button>}>
    {message}
  </Notice>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="skeleton" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <span key={i} />)}</div>;
}
