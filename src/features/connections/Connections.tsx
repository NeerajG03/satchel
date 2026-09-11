import {useEffect,useState} from 'react';
import type {SupabaseClient,OAuthAuthorizationDetails} from '@supabase/supabase-js';
import {errorMessage} from '../../client';
import {requestWithTimeout} from '../../request.mjs';

type Project={id:string;name:string};
type Connection={client_id:string;label:string;personal:boolean;project_ids:string[];can_write:boolean;revoked_at:string|null};
export function Connections({db,authorizationId}:{db:SupabaseClient;authorizationId?:string}) {
  const [projects,setProjects]=useState<Project[]>([]);
  const [connections,setConnections]=useState<Connection[]>([]);
  const [details,setDetails]=useState<OAuthAuthorizationDetails|null>(null);
  const [personal,setPersonal]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);
  const [write,setWrite]=useState(false);
  const [busy,setBusy]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  async function load() {
    setError('');setLoaded(false);
    try {
      const [p,c]=await Promise.all([
        requestWithTimeout(signal=>db.from('projects').select('id,name').order('name').abortSignal(signal)),
        requestWithTimeout(signal=>db.from('agent_connections').select('client_id,label,personal,project_ids,can_write,revoked_at').order('created_at').abortSignal(signal)),
      ]);
      if(p.error)throw p.error;if(c.error)throw c.error;
      setProjects(p.data??[]);setConnections(c.data??[]);
      if(authorizationId){
        const {data,error}=await db.auth.oauth.getAuthorizationDetails(authorizationId);
        if(error)throw error;
        if('redirect_url' in data){sessionStorage.removeItem('satchel-authorization');location.assign(data.redirect_url);return;}
        setDetails(data);
      }
      setLoaded(true);
    }catch(e){setError(errorMessage(e,'load'));}
  }
  useEffect(()=>{void load();},[db,authorizationId]);
  async function consent(approve:boolean) {
    if(!authorizationId||!details)return;
    setBusy(true);setError('');
    try {
      if(approve){
        const {error}=await requestWithTimeout(signal=>db.rpc('authorize_agent',{
          p_client_id:details.client.id,p_label:details.client.name.slice(0,100)||'Agent connection',
          p_personal:personal,p_project_ids:selected,p_can_write:write,
        }).abortSignal(signal));
        if(error)throw error;
      }
      const {data,error}=approve
        ?await db.auth.oauth.approveAuthorization(authorizationId,{skipBrowserRedirect:true})
        :await db.auth.oauth.denyAuthorization(authorizationId,{skipBrowserRedirect:true});
      if(error)throw error;
      sessionStorage.removeItem('satchel-authorization');
      location.assign(data.redirect_url);
    }catch(e){setError(errorMessage(e));setBusy(false);}
  }
  async function revoke(connection:Connection) {
    setBusy(true);setError('');setNotice('');
    try {
      const {error}=await requestWithTimeout(signal=>db.rpc('revoke_agent',{p_client_id:connection.client_id}).abortSignal(signal));
      if(error)throw error;
      // Server-side data access stops first, even if provider cleanup fails.
      const {error:oauthError}=await db.auth.oauth.revokeGrant({clientId:connection.client_id});
      setNotice(oauthError?'Memory access revoked. OAuth cleanup failed; reconnecting may require clearing authentication in the agent.':'Access revoked. Previously retrieved chat content is unchanged.');
      await load();
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  return <section className="book connections">
    <div className="eyebrow">YOUR CONNECTIONS</div>
    <h1>{authorizationId?'Connect your agent.':'Your agents.'}</h1>
    <p>Each client gets only the memory scopes you choose. Permissions apply to every installation using that client identity.</p>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {notice&&<p className="notice" role="status">{notice}</p>}
    {!loaded&&!error&&<p role="status">Loading connections…</p>}
    {error&&<button disabled={busy} onClick={()=>void load()}>Retry</button>}
    {details&&<>
      <h2>{details.client.name}</h2>
      <p className="fine muted">Client-provided name · ID {details.client.id}</p>
      <p className="fine">Return address: {details.redirect_uri}</p>
      <fieldset disabled={busy||!loaded}>
        <legend>Allow this client to read</legend>
        <label className="choice"><input type="checkbox" checked={personal} onChange={e=>setPersonal(e.target.checked)}/>For me — personal memories</label>
        {projects.map(p=><label className="choice" key={p.id}><input type="checkbox" checked={selected.includes(p.id)} onChange={e=>setSelected(e.target.checked?[...selected,p.id]:selected.filter(id=>id!==p.id))}/>{p.name}</label>)}
        <label className="choice"><input type="checkbox" checked={write} onChange={e=>setWrite(e.target.checked)}/>Also allow explicit saves, corrections and deletions in these scopes</label>
      </fieldset>
      <p className="fine">Automatic hooks only read names and descriptions. More info is available on demand. Writing requires the permission above and your explicit request to the agent.</p>
      <div className="header-actions"><button className="primary" disabled={busy||!loaded||(!personal&&!selected.length)} onClick={()=>void consent(true)}>Allow access</button><button disabled={busy} onClick={()=>void consent(false)}>Deny</button></div>
    </>}
    {!authorizationId&&loaded&&<>
      {!connections.length&&<p>No agents connected yet. Install the Satchel plugin in your agent, then sign in from its MCP connection settings.</p>}
      {connections.map(c=><article key={c.client_id}>
        <h2>{c.label}</h2>
        <p>{c.personal?'Personal memory':''}{c.personal&&c.project_ids.length?' · ':''}{c.project_ids.map(id=>projects.find(p=>p.id===id)?.name??'Unavailable project').join(', ')}</p>
        <p className="fine muted">{c.can_write?'Read and write':'Read only'} · {c.revoked_at?'Revoked':'Connected'}</p>
        <button disabled={busy||!!c.revoked_at} onClick={()=>void revoke(c)}>Revoke access</button>
      </article>)}
    </>}
  </section>;
}
