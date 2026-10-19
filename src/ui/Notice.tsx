import type { ReactNode } from 'react';
import { LOAD_FAILED } from '../errorText.mjs';

type Props = { title?: string; children?: ReactNode; actions?: ReactNode; look?: 'error' | 'amber' | 'plain' };

export function Notice({ title, children, actions, look = 'plain' }: Props) {
  return <div className={`notice ${look === 'plain' ? '' : look}`.trim()} role={look === 'error' ? 'alert' : undefined}>
    {title && <strong>{title}</strong>}
    {children && <div>{children}</div>}
    {actions && <div className="actions">{actions}</div>}
  </div>;
}

/** `message` is the mapped reason from useLoad. The connection wording is only
 *  right when the reason is unknown; a page that loaded fine but named
 *  something gone, or a session that ran out, says that instead. */
export function LoadError({ what, onReload, message }: { what: string; onReload: () => void; message?: string }) {
  const reason = message && message !== LOAD_FAILED ? message : '';
  return <Notice look="error" title={reason ? `${what} didn’t load.` : 'Couldn’t reach your Satchel.'}
    actions={<button type="button" className="btn sm" onClick={onReload}>Reload</button>}>
    {reason || `${what} didn’t load. Nothing is lost. Your apps keep whatever they already read.`}
  </Notice>;
}

export function SaveError({ message, onRetry, title = 'Could not save.' }: { message: string; onRetry?: () => void; title?: string }) {
  return <Notice look="error" title={title}
    actions={onRetry && <button type="button" className="btn sm" onClick={onRetry}>Try again</button>}>
    {message}
  </Notice>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="skeleton" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <span key={i} />)}</div>;
}
