import { handleOf } from '../memories/model';
import { summarizeJobRun, type ConsolidationJob } from './model';

/** Every session a pass read, and every change it made with the model's own
 *  reason. Shared by the newest job's card and the list of earlier ones, so a
 *  report reads the same whichever day you open it. */
export function JobReport({ job }: { job: ConsolidationJob }) {
  return <ol className="job-report">{(job.runs ?? []).map((run, index) => <li key={run.document ?? index}>
    <div className="between">
      <span className="eyebrow">{run.scope ?? 'session'} · {(run.session_key ?? run.document ?? '').slice(0, 8)}</span>
      <span className={`fine ${run.failed ? 'error-text' : 'muted'}`}>{summarizeJobRun(run)}</span>
    </div>
    {(run.actions ?? []).length > 0 && <ul className="plain-list">{run.actions!.map((action, i) =>
      <li key={i} className="fine">
        <strong>{action.did}</strong>{action.on ? ` ${handleOf(action.on)}` : ''}
        {action.statement ? `: ${action.statement}` : ''}
        {action.why && <span className="muted"> ({action.why})</span>}
      </li>)}</ul>}
  </li>)}</ol>;
}
