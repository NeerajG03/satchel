import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useStores } from '../../app/stores';
import { useFooter } from '../../app/readout';
import { LinkButton } from '../../ui/Button';
import { PROVIDER_LABEL, type Provider } from './repository';

/** Where Google or Notion sends the person back after its consent screen. */
export function ConnectCallback() {
  const stores = useStores();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const provider: Provider = useLocation().pathname.endsWith('/notion') ? 'notion' : 'google';
  const name = PROVIDER_LABEL[provider];
  const [problem, setProblem] = useState('');
  // A code works once; React may run an effect twice in development.
  const ran = useRef(false);
  useFooter(problem ? '' : `Connecting ${name}…`);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    stores.integrations.finish(provider, params)
      .then(connection => navigate('/settings', { replace: true,
        state: { connected: `${name} is connected: ${connection.label}. Now pick where things go.` } }))
      .catch(reason => setProblem(reason instanceof Error ? reason.message : `${name} did not finish connecting. Try again.`));
  }, [stores, params, navigate, provider, name]);

  return <>
    <div className="head"><div className="col"><span className="eyebrow">Settings · {name}</span>
      <h1>{problem ? 'Nothing was connected.' : `Connecting ${name}…`}</h1></div></div>
    {problem && <div role="alert" className="notice"><p>{problem}</p>
      <LinkButton to="/settings">Back to Settings</LinkButton></div>}
  </>;
}
