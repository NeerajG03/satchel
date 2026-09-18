import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { RETURN_URL_KEY } from './Consent';
import { Light } from '../../ui/Light';
import { CLAUDE_MARK, CODEX_MARK, Mark } from './marks';
import { SatchelMark } from '../../ui/SatchelMark';

const PARTNER: Record<string, { name: string; className: string; mark?: string }> = {
  claude: { name: 'Claude', className: 'partner-claude', mark: CLAUDE_MARK },
  openai: { name: 'Codex', className: 'partner-openai', mark: CODEX_MARK },
};

export function Connected() {
  const { partner = 'other' } = useParams();
  const [ret, setRet] = useState<{ url: string; name: string } | null>(null);
  useEffect(() => {
    try { const raw = sessionStorage.getItem(RETURN_URL_KEY); if (raw) setRet(JSON.parse(raw)); } catch { /* Fall back to Back to Apps. */ }
  }, []);
  const look = PARTNER[partner] ?? { name: ret?.name ?? 'your app', className: 'partner-plain' };
  const appName = PARTNER[partner] ? look.name : ret?.name ?? look.name;
  const safeReturn = ret?.url && /^https?:\/\//i.test(ret.url) ? ret.url : null;

  return <div className="split">
    <section className="satchel">
      <span className="wordmark"><SatchelMark size={34} />satchel</span>
      <Light color="green" word="Connected" verify />
      <h2 style={{ fontSize: 34 }}>{appName} can now read your Satchel.</h2>
      <p className="lede">Only what you just allowed. Change or revoke it any time in Apps.</p>
      <Link to="/apps" className="btn" style={{ alignSelf: 'flex-start' }}>Back to Apps</Link>
    </section>
    <span className="seam" aria-hidden="true">×</span>
    <section className={look.className}>
      {look.mark && <Mark svg={look.mark} className="partner-mark" />}
      {look.mark && <span className="partner-lockup"><Mark svg={look.mark} className="partner-lockup-mark" />{look.name}</span>}
      <span className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Next</span>
      <h2 style={{ fontSize: 34 }}>Go back to {appName}.</h2>
      <p className="lede">Your next chat starts with your memory index already loaded. You can close this tab.</p>
      {safeReturn ? <a href={safeReturn} className="btn" style={{ alignSelf: 'flex-start' }}>Return to {appName}</a>
        : <span className="fine" style={{ opacity: 0.7 }}>It is waiting for this window.</span>}
    </section>
  </div>;
}
