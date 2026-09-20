import { Link } from 'react-router';
import type { Project } from '../projects/repository';
import { LinkButton } from '../../ui/Button';
import { Notice } from '../../ui/Notice';

const STEPS = [
  { n: '01 · Two minutes', title: 'Write the first thing down', text: 'A preference about how you like to work. It applies everywhere, no project needed.', to: '/book?compose=1', label: 'Open the book' },
  { n: '02 · Five minutes', title: 'Connect an AI app', text: 'Install the Satchel plugin in Claude Code or Codex, then sign in from its connection settings. You choose what it can read.', to: '/apps', label: 'See the steps' },
  { n: '03 · When you have one', title: 'Capture a task', text: 'A title and the next action. Later, a handoff makes it resumable from any device.', to: '/tasks?compose=1', label: 'Capture a task' },
];

export function LeftOffEmpty({ name, projects }: { name: string; projects: Project[] }) {
  const first = name.split(/[\s@]/)[0] || 'there';
  return <>
    <div className="col" style={{ gap: 8 }}>
      <span className="eyebrow">First run</span>
      <h1>Welcome, {first}.</h1>
      <p className="lede">Your Satchel is empty, which is the right place to start. Do any one of these three and this page turns into “Where you left off”.</p>
    </div>
    <div className="steps">
      {STEPS.map(step => <div className="step" key={step.n}>
        <span className="n">{step.n}</span>
        <h3>{step.title}</h3>
        <p className="muted">{step.text}</p>
        <LinkButton to={step.to} look={step.n.startsWith('01') ? 'primary' : 'default'}>{step.label}</LinkButton>
      </div>)}
    </div>
    {projects.length > 0 && <Notice look="amber" actions={<Link to="/projects" className="btn sm">View projects</Link>}>
      You have {projects.length} {projects.length === 1 ? 'project' : 'projects'} but nothing in {projects.length === 1 ? 'it' : 'them'} yet. {projects.map(p => p.name).join(', ')} {projects.length === 1 ? 'was' : 'were'} created earlier. A project with no memories or tasks is invisible to agents until you add something.
    </Notice>}
  </>;
}
