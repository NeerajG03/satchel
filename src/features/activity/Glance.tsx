import { useState } from 'react';
import { useStores } from '../../app/stores';
import { useLoad } from '../../app/useLoad';
import { count, whenText } from '../../app/format';
import { Button } from '../../ui/Button';
import { Light } from '../../ui/Light';
import { Notice } from '../../ui/Notice';
import { memorySet, modelHealth, splitWaiting, type ModelCall, type ModelHealth, type ScheduleStatus, type WaitingDoc } from './overview';
import { jobState, summarizeJob, type ConsolidationJob } from './model';
import { JobReport } from './JobReport';

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** One card in the overview. The heading is a readout, so it is mono; what is
 *  inside is ordinary interface text. */
function Panel({ title, light, children }: { title: string; light?: React.ReactNode; children: React.ReactNode }) {
  return <section className="panel" aria-label={title}>
    <div className="between"><h2 className="eyebrow">{title}</h2>{light}</div>
    {children}
  </section>;
}

/** What the button would read if you pressed it now, and what it would leave
 *  because the conversation is still going. */
function Waiting({ docs, slugs }: { docs: WaitingDoc[]; slugs: Map<string, string> }) {
  const { ready, active } = splitWaiting(docs);
  const shown = ready.slice(-5).reverse();
  return <Panel title="Waiting to be read"
    light={ready.length ? <Light color="amber" word={`${ready.length} ready`} /> : <Light color="off" word="nothing ready" />}>
    <p className="glance-line">{count(ready.length, 'session')} ready · {active.length} still going</p>
    {shown.length > 0 && <ul className="glance-list">{shown.map(doc => <li key={doc.id}>
      <span className="mono">{doc.project_id ? slugs.get(doc.project_id) ?? 'a project' : 'personal'} · {doc.session_key.slice(0, 8)}</span>
      <span className="fine muted">{count(doc.turns, 'turn')} · {doc.consolidated_through === null ? 'never read' : 'read before, has more'} · quiet since {whenText(doc.last_turn_at)}</span>
    </li>)}</ul>}
    {ready.length > shown.length && <p className="fine muted">And {ready.length - shown.length} older.</p>}
    <p className="fine muted">{docs.length
      ? 'The button reads a session once it has been quiet for 30 minutes. The rest wait for the next press.'
      : 'Nothing is waiting. Every kept conversation has been read.'}</p>
  </Panel>;
}

const HEALTH = {
  answering: { color: 'green', word: 'answering' },
  quota: { color: 'red', word: 'quota used' },
  failing: { color: 'amber', word: 'failing' },
} as const;

/** Whether each model is answering today. A spent quota says so in its own
 *  words, because it fixes itself at the reset and nothing else does. */
function Models({ health, since, lastCall }: { health: ModelHealth[]; since: number; lastCall: ModelCall | null }) {
  return <Panel title="Models since the quota reset">
    {health.length === 0 && <p className="fine">No model calls since {time(since)}.
      {lastCall && <> The last one was <span className="mono">{lastCall.model}</span>, {whenText(lastCall.created_at)},
        for a {lastCall.source}{lastCall.error ? ', and it failed' : ''}.</>}</p>}
    {health.length > 0 && <ul className="glance-list">{health.map(model => <li key={model.model}>
      <div className="between">
        <span className="mono">{model.model}</span>
        <Light color={HEALTH[model.state].color} word={HEALTH[model.state].word} />
      </div>
      <span className="fine muted">{model.answered} answered · {model.failed} refused · last call {whenText(model.last.created_at)}</span>
      {model.state !== 'answering' && model.lastError && <span className="fine error-text">{model.lastError.slice(0, 160)}</span>}
    </li>)}</ul>}
    <p className="fine muted">Counts what this deployment logged since {time(since)}, when Gemini's free quota
      resets. Evals on the same key use the quota too and are not in here.</p>
  </Panel>;
}

/** Whether anything runs without you pressing the button. */
function Schedule({ status }: { status: ScheduleStatus | null }) {
  if (!status) return <Panel title="Schedule" light={<Light color="off" word="off" />}>
    <p className="fine">Nothing runs on its own. The button is the only way a pass starts.</p>
  </Panel>;
  const answered = status.last_status !== null && status.last_status >= 200 && status.last_status < 300;
  const light = !status.enabled
    ? <Light color={status.failures >= 3 ? 'red' : 'off'} word={status.failures >= 3 ? 'switched off' : 'off'} />
    : !status.scheduled ? <Light color="amber" word="not installed" />
    : status.failures > 0 ? <Light color="amber" word={`${status.failures} refused`} />
    : answered ? <Light color="green" word="working" />
    : <Light color="amber" word="not run yet" />;
  return <Panel title="Schedule" light={light}>
    <p className="fine">{!status.enabled
      ? status.failures >= 3 ? 'Switched off after three refusals in a row.' : 'Switched off. Only the button runs a pass.'
      : !status.scheduled ? 'Switched on, but the timer that runs it is not installed on this database.'
      : `Every six hours, for sessions quiet for ${status.idle_minutes} minutes.`}</p>
    <dl className="facts">
      <dt>last run</dt><dd>{status.last_run_at ? whenText(status.last_run_at) : 'never'}</dd>
      {status.last_status !== null && <><dt>last answer</dt><dd>{status.last_status}</dd></>}
    </dl>
    {status.last_error && <p className="fine error-text">{status.last_error.slice(0, 200)}</p>}
  </Panel>;
}

/** What the memory set holds right now, by scope and by kind. */
function MemorySet({ set }: { set: ReturnType<typeof memorySet> }) {
  return <Panel title="Memory set">
    <p className="glance-line">{set.live} live · {set.heard} picked up by Satchel</p>
    {set.live > 0 && <>
      <dl className="facts">
        {set.scopes.map(([scope, n]) => <div key={scope} style={{ display: 'contents' }}><dt>{scope}</dt><dd>{n}</dd></div>)}
      </dl>
      <p className="fine muted">{set.kinds.map(([kind, n]) => count(n, kind)).join(' · ')}</p>
    </>}
    {set.live === 0 && <p className="fine muted">No live memories yet.</p>}
  </Panel>;
}

/** The four answers at the top of the page. Read again whenever `version`
 *  moves, which the page does on Reload and when a pass stops. */
export function Glance({ version }: { version: number }) {
  const stores = useStores();
  const overview = useLoad(() => stores.activity.overview(), [stores, version]);
  if (overview.error) return <Notice look="error" title="Could not load the overview"
    actions={<Button small onClick={overview.reload}>Reload</Button>}>{overview.error}</Notice>;
  if (!overview.data) return <div className="glance skeleton" aria-hidden="true">
    {[0, 1, 2, 3].map(n => <div key={n} className="panel"><p className="desc">&nbsp;</p></div>)}
  </div>;
  const data = overview.data;
  return <div className="glance">
    <Waiting docs={data.waiting} slugs={data.slugs} />
    <Models health={modelHealth(data.calls)} since={data.since} lastCall={data.lastCall} />
    <Schedule status={data.schedule} />
    <MemorySet set={memorySet(data.memories, data.slugs)} />
  </div>;
}

/** The passes before the newest one, each with its report a click away. */
export function EarlierJobs({ version, latest }: { version: number; latest: string | null }) {
  const stores = useStores();
  const jobs = useLoad(() => stores.activity.recentJobs(6), [stores, version, latest]);
  const [open, setOpen] = useState('');
  const earlier = (jobs.data ?? []).filter(job => job.id !== latest);
  if (jobs.error) return <p className="fine error-text" role="alert">Could not read earlier passes. {jobs.error}</p>;
  if (!earlier.length) return null;
  return <section className="stack-tight" aria-label="Earlier passes">
    <h2 className="eyebrow">Earlier passes</h2>
    <ul className="glance-list">{earlier.map((job: ConsolidationJob) => {
      const expanded = open === job.id;
      const state = jobState(job);
      return <li key={job.id}>
        <div className="between">
          <span className="fine"><span className="mono">{whenText(job.started_at)}</span> · {summarizeJob(job)}</span>
          {(job.runs ?? []).length > 0 && <Button look="quiet" small aria-expanded={expanded}
            onClick={() => setOpen(expanded ? '' : job.id)}>{expanded ? 'Hide' : 'Report'}</Button>}
        </div>
        {state === 'stopped' && job.stop_reason && <span className="fine muted">{job.stop_reason}</span>}
        {expanded && <JobReport job={job} />}
      </li>;
    })}</ul>
  </section>;
}
