import { useEffect, useState } from 'react';
import { useStores } from '../../app/stores';
import { useAction, useLoad } from '../../app/useLoad';
import { useReadout } from '../../app/readout';
import { Button } from '../../ui/Button';
import { CheckField, TextField } from '../../ui/Field';
import { LoadError, SaveError, Skeleton } from '../../ui/Notice';
import { REPLY_LIMIT } from './repository';

export function ReplyCheck() {
  const stores = useStores();
  const { announce } = useReadout();
  const saved = useLoad(() => stores.replyCheck.get(), [stores]);
  const action = useAction();
  const [limit, setLimit] = useState(String(REPLY_LIMIT.fallback));

  const row = saved.data;
  useEffect(() => { if (row) setLimit(String(row.reply_word_limit)); }, [row]);

  const words = Number(limit);
  const valid = Number.isInteger(words) && words >= REPLY_LIMIT.min && words <= REPLY_LIMIT.max;
  const dirty = row !== null && valid && words !== row.reply_word_limit;

  async function save(next: { reply_check: boolean; reply_word_limit: number }, message: string) {
    const done = await action.run(async () => { await stores.replyCheck.save(next); saved.reload(); return true; });
    if (done) announce(message);
  }

  return <div className="settings-row">
    <h2>Reply check</h2>
    <div className="stack-tight">
      <p className="muted">Your agent’s last reply is checked before you see it. If it is too long or
        uses file and code names, the agent is asked to rewrite it once. Nothing else about the reply changes.</p>
      {saved.loading && !row ? <Skeleton rows={2} />
        : saved.error ? <LoadError what="The reply check" message={saved.error} onReload={saved.reload} />
        : <>
          <CheckField label="Check replies before you see them"
            hint="asks the agent to rewrite once if a reply is too long or uses code names"
            checked={row?.reply_check ?? false} disabled={action.busy || !row}
            onChange={e => void save({ reply_check: e.target.checked, reply_word_limit: row?.reply_word_limit ?? REPLY_LIMIT.fallback },
              e.target.checked ? 'Reply check is on' : 'Reply check is off')} />
          <TextField label="Longest reply, in words" type="number" inputMode="numeric"
            min={REPLY_LIMIT.min} max={REPLY_LIMIT.max} step={10} value={limit}
            hint={`${REPLY_LIMIT.min} to ${REPLY_LIMIT.max}`} disabled={action.busy || !row}
            onChange={e => setLimit(e.target.value)} />
          {!valid && <p className="fine error-text" role="alert">Pick a number from {REPLY_LIMIT.min} to {REPLY_LIMIT.max}.</p>}
          <div className="row wrap">
            <Button look="primary" disabled={action.busy || !dirty}
              onClick={() => void save({ reply_check: row?.reply_check ?? false, reply_word_limit: words }, `Reply limit saved · ${words} words`)}>
              {action.busy ? 'Working…' : 'Save limit'}</Button>
          </div>
          {action.error && <SaveError message={action.error} />}
        </>}
    </div>
  </div>;
}
