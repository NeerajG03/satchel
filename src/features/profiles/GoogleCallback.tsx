import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useStores } from '../../app/stores';
import { useFooter } from '../../app/readout';
import { LinkButton } from '../../ui/Button';
import { PROFILE_LABEL } from './repository';

/** Where Google sends the person back after its consent screen. */
export function GoogleCallback() {
  const stores = useStores();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [problem, setProblem] = useState('');
  // A Google code works once; React may run an effect twice in development.
  const ran = useRef(false);
  useFooter(problem ? '' : 'Linking Google…');

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    stores.google.finish(params)
      .then(link => navigate('/settings', { replace: true,
        state: { googleLinked: `${PROFILE_LABEL[link.profile]} is linked to ${link.email}` } }))
      .catch(reason => setProblem(reason instanceof Error ? reason.message : 'Google did not finish linking. Try again.'));
  }, [stores, params, navigate]);

  return <>
    <div className="head"><div className="col"><span className="eyebrow">Settings · Google</span>
      <h1>{problem ? 'Nothing was linked.' : 'Linking your Google account…'}</h1></div></div>
    {problem && <div role="alert" className="notice"><p>{problem}</p>
      <LinkButton to="/settings">Back to Settings</LinkButton></div>}
  </>;
}
