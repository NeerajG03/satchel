import { Link } from 'react-router';
import { useAuth } from '../app/auth';
import { useReadout } from '../app/readout';
import { todayLine } from '../app/format';
import { Light } from '../ui/Light';
import { SatchelMark } from '../ui/SatchelMark';
import { isDesktop } from '../platform';

export function accountHandle(user: { email?: string; user_metadata?: Record<string, unknown> } | null): string {
  const meta = user?.user_metadata ?? {};
  const handle = meta.user_name ?? meta.preferred_username ?? meta.name;
  return typeof handle === 'string' && handle ? handle : user?.email ?? '';
}

export function Header() {
  const { user } = useAuth();
  const { status } = useReadout();
  // In the desktop shell the header doubles as the window title bar: drag to move, double-click to zoom.
  return <header className="top hw" data-tauri-drag-region={isDesktop || undefined}>
    <Link to="/" className="wordmark"><SatchelMark size={28} />satchel</Link>
    <div className="topmeta">
      <span className="hide-narrow">{todayLine()}</span>
      {user && <Light color={status.light} word={status.word} />}
      {user && <strong className="hide-narrow">{accountHandle(user)}</strong>}
    </div>
  </header>;
}
