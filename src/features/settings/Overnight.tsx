import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import { fullDate, whenText } from '../../app/format';
import { Button } from '../../ui/Button';
import { CheckField, SelectField, TextField } from '../../ui/Field';
import { Light } from '../../ui/Light';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { beginEnable } from './consolidationConnect';
import { DAY_NAMES, EVERY_DAY, WEEKDAYS, describeSchedule, nextRun, sameSchedule, scheduleProblem, type Schedule } from './schedule.mjs';

const ZONE = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function Overnight() {
  const stores = useStores();
  const { announce } = useReadout();
  const location = useLocation();
  const navigate = useNavigate();
  const status = useLoad(() => stores.overnight.status(), [stores]);
  const action = useAction();
  const zone = useMemo(ZONE, []);
  const [days, setDays] = useState<number[]>(EVERY_DAY);
  const [twice, setTwice] = useState(false);
  const [first, setFirst] = useState('02:00');
  const [second, setSecond] = useState('14:00');
  const [justOff, setJustOff] = useState(false);

  const row = status.data;
  const on = row?.enabled ?? false;
  useEffect(() => {
    if (!row) return;
    setDays(row.days); setTwice(row.times.length === 2); setFirst(row.times[0] ?? '02:00'); setSecond(row.times[1] ?? '14:00');
  }, [row]);

  // The callback page sends the person back here with this flag. A message
  // announced there would be cleared as that page unmounts. It is said once and
  // the flag is dropped, so a later save or a refresh does not say it again over
  // whatever the footer holds by then.
  const switchedOn = Boolean((location.state as { overnightOn?: boolean } | null)?.overnightOn);
  const told = useRef(false);
  useEffect(() => {
    if (!switchedOn || !row?.enabled || told.current) return;
    told.current = true;
    announce(`Overnight pass is on · ${describeSchedule(row)}`);
    navigate(location.pathname, { replace: true, state: null });
  }, [switchedOn, row, announce, navigate, location.pathname]);

  const draft: Schedule = { days, times: twice ? [first, second] : [first], timezone: zone };
  const problem = scheduleProblem(draft);
  const dirty = row !== null && on && !sameSchedule(row, draft);

  async function toggle(next: boolean) {
    if (next) {
      if (problem) return;
      await action.run(() => beginEnable(draft));
      return;
    }
    await action.run(async () => {
      await stores.overnight.disable();
      setJustOff(true);
      status.reload();
      announce('Overnight pass is off · the stored sign-in was deleted');
    });
  }
  async function clearStored() {
    await action.run(async () => {
      await stores.overnight.disable();
      setJustOff(true);
      status.reload();
      announce('The stored sign-in was deleted');
    });
  }
  async function save() {
    const saved = await action.run(async () => {
      await stores.overnight.setSchedule(draft);
      status.reload();
      return true;
    });
    if (saved) announce(`Overnight schedule saved · ${describeSchedule(draft)}`);
  }
  const pickDay = (day: number, picked: boolean) => setDays(current => picked ? [...current, day] : current.filter(d => d !== day));

  const after = useMemo(() => row && on ? nextRun(row) : null, [row, on]);
  const answered = row?.last_status != null && row.last_status >= 200 && row.last_status < 300;

  return <div className="settings-row">
    <h2>Overnight pass</h2>
    <div className="stack-tight">
      <p className="muted">While you are away, Satchel reads the conversations that have gone quiet and
        updates your memory from them. It signs in as its own connection, listed in Apps as Satchel
        consolidation, and you can revoke it there. It is off until you switch it on.</p>
      {status.loading && !row ? <Skeleton rows={3} />
        : status.error ? <LoadError what="The overnight pass" onReload={status.reload} />
        : <>
          <CheckField label="Run overnight" checked={on}
            disabled={action.busy || (!on && problem !== null)} onChange={e => void toggle(e.target.checked)} />
          {row && !row.enabled && <div className="stack-tight">
            <p className="fine error-text" role="alert">Switched off after three refusals in a row. Switch it on again to sign it in fresh, or delete what is stored.</p>
            <Button small disabled={action.busy} onClick={() => void clearStored()}>Delete the stored sign-in</Button>
          </div>}
          {justOff && !on && <p className="fine">Off. The stored sign-in is deleted. The connection stays listed
            in <Link to="/apps">Apps</Link> until you revoke it there.</p>}

          <SelectField label="How often" value={twice ? 'twice' : 'once'} disabled={action.busy}
            onChange={e => setTwice(e.target.value === 'twice')}>
            <option value="once">Once a day</option>
            <option value="twice">Twice a day</option>
          </SelectField>
          <div className="row wrap">
            <TextField label={twice ? 'First run' : 'Run at'} type="time" step={60} required value={first}
              disabled={action.busy} onChange={e => setFirst(e.target.value)} />
            {twice && <TextField label="Second run" type="time" step={60} required value={second}
              disabled={action.busy} onChange={e => setSecond(e.target.value)} />}
          </div>
          <fieldset className="days" disabled={action.busy}>
            <legend>On these days</legend>
            <div className="row wrap">
              {DAY_NAMES.map((name, day) => <CheckField key={name} label={name} checked={days.includes(day)}
                onChange={e => pickDay(day, e.target.checked)} />)}
            </div>
            <span className="row fine">
              <Button look="link" small onClick={() => setDays(EVERY_DAY)}>Every day</Button>
              <span className="muted">·</span>
              <Button look="link" small onClick={() => setDays(WEEKDAYS)}>Weekdays</Button>
            </span>
          </fieldset>
          <p className="fine muted">Times are in {zone}, this browser’s time zone. A pass only runs when
            there is a conversation that has been quiet for 30 minutes, so a night with nothing new costs nothing.</p>
          {problem && <p className="fine error-text" role="alert">{problem}</p>}

          {on && <div className="row wrap">
            <Button look="primary" disabled={action.busy || !dirty || problem !== null} onClick={() => void save()}>
              {action.busy ? 'Working…' : 'Save schedule'}</Button>
          </div>}
          {action.error && <SaveError message={action.error} />}

          {row && on && <>
            <div className="row wrap">
              {!row.scheduled ? <Light color="amber" word="not installed" />
                : row.failures > 0 ? <Light color="amber" word={`${row.failures} refused`} />
                : answered ? <Light color="green" word="working" />
                : <Light color="amber" word="not run yet" />}
              <span className="fine">{describeSchedule(row)}</span>
            </div>
            {!row.scheduled && <p className="fine">Switched on, but the timer that runs it is not installed on this database.</p>}
            <dl className="facts">
              <dt>last run</dt><dd>{row.last_run_at ? whenText(row.last_run_at) : 'never'}</dd>
              <dt>next run</dt><dd>{after ? fullDate(after.toISOString()) : 'none'}</dd>
            </dl>
            {row.last_error && <p className="fine error-text">{row.last_error.slice(0, 200)}</p>}
          </>}
        </>}
    </div>
  </div>;
}
