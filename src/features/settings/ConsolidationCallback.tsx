import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useStores } from '../../app/stores';
import { errorMessage } from '../../client';
import { useFooter } from '../../app/readout';
import { SaveError, Skeleton } from '../../ui/Notice';
import { finishEnable } from './consolidationConnect';

// One run per code. A code can be swapped once, and React may run an effect
// twice in development. The second run would find the stored verifier already
// used and report a failure on a switch-on that worked.
const runs = new Map<string, Promise<void>>();

export function ConsolidationCallback() {
  const stores = useStores();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState('');
  useFooter('Switching on the overnight pass');

  useEffect(() => {
    const key = params.toString();
    let run = runs.get(key);
    if (!run) {
      run = (async () => {
        const done = await finishEnable(params);
        await stores.overnight.enable(done);
      })();
      runs.set(key, run);
    }
    run.then(() => navigate('/settings', { replace: true, state: { overnightOn: true } }))
      .catch(reason => setError(errorMessage(reason)));
  }, [params, stores, navigate]);

  return <>
    <div className="head"><div className="col"><span className="eyebrow">Settings</span><h1>Switching on the overnight pass.</h1></div></div>
    {error
      ? <div className="stack-tight"><SaveError message={error} /><p><Link to="/settings" className="btn">Back to Settings</Link></p></div>
      : <Skeleton rows={3} />}
  </>;
}
