import { useAuth } from '../../app/auth';
import { Button } from '../../ui/Button';
import { Notice } from '../../ui/Notice';

const POINTS = [
  ['The book', 'Preferences and decisions you chose to save. Names and short descriptions form an index agents read first.'],
  ['Topics', 'One subject, its repositories and the apps allowed to see it.'],
  ['Apps', 'Each connected agent gets only the scopes you grant. Revoke any time.'],
];

export function Welcome() {
  const { db, busy, error, signIn } = useAuth();
  return <main className="welcome">
    <div>
      <span className="eyebrow">Your work, with you</span>
      <h1>A place for what you want to remember.</h1>
      <p className="intro">Keep the decisions and preferences that make your work yours. Write them once. Every connected AI app can read them.</p>
      {db ? <div className="stack-tight" style={{ alignItems: 'flex-start' }}>
        <Button look="primary" disabled={busy} onClick={() => void signIn('google')}>{busy ? 'Opening sign-in…' : 'Continue with Google'} <span aria-hidden="true">↗</span></Button>
        <Button look="link" small disabled={busy} onClick={() => void signIn('github')}>Use GitHub instead</Button>
        <p className="fine muted">Your account is only used to sign you in. Satchel asks for nothing else here.</p>
        {error && <Notice look="error" title="Sign-in didn’t finish.">{error}</Notice>}
      </div> : <Notice look="amber">This instance is awaiting account setup. Sign-in will be available once it is connected.</Notice>}
    </div>
    <ul className="list">
      {POINTS.map(([title, text]) => <li key={title}><strong>{title}</strong><span className="muted">{text}</span></li>)}
    </ul>
    <div className="welcome-foot"><span className="rule" /><span className="eyebrow">Satchel · Private pilot</span></div>
  </main>;
}
