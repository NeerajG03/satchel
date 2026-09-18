import { useAuth } from '../../app/auth';
import { isDesktop } from '../../platform';
import { Button } from '../../ui/Button';
import { Notice } from '../../ui/Notice';

const POINTS = [
  ['The book', 'Preferences and decisions you chose to save. Names and short descriptions form an index agents read first.'],
  ['Tasks and handoffs', 'The exact next action and the evidence the last session left behind.'],
  ['Projects', 'One effort, its repositories and the apps allowed to see it.'],
  ['Apps', 'Each connected agent gets only the scopes you grant. Revoke any time.'],
];

export function Welcome() {
  const { db, busy, error, signIn, cancelSignIn } = useAuth();
  return <main className="welcome">
    <div>
      <span className="eyebrow">Your work, with you</span>
      <h1>A place for what you want to remember.</h1>
      <p className="intro">Keep the decisions, preferences and next steps that make a project yours. Write them once. Every connected AI app can read them.</p>
      {db ? <div className="stack-tight" style={{ alignItems: 'flex-start' }}>
        <Button look="primary" disabled={busy} onClick={() => void signIn()}>{busy ? (isDesktop ? 'Waiting for GitHub in your browser…' : 'Opening GitHub…') : 'Continue with GitHub'} <span aria-hidden="true">↗</span></Button>
        {isDesktop && busy && <Button look="quiet" small onClick={cancelSignIn}>Cancel</Button>}
        <p className="fine muted">GitHub is only used to sign you in. Satchel never asks for repository access here.{isDesktop && ' GitHub opens in your browser and brings you back to this app.'}</p>
        {error && <Notice look="error" title="GitHub sign-in didn’t finish.">{error}</Notice>}
      </div> : <Notice look="amber">This instance is awaiting account setup. Sign-in will be available once it is connected.</Notice>}
    </div>
    <ul className="list">
      {POINTS.map(([title, text]) => <li key={title}><strong>{title}</strong><span className="muted">{text}</span></li>)}
    </ul>
    <div className="welcome-foot"><span className="rule" /><span className="eyebrow">Satchel · Private pilot</span></div>
  </main>;
}
