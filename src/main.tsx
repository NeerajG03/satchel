import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { User } from '@supabase/supabase-js';
import { client, errorMessage, type Project, type Memory } from './client';
import './style.css';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!client);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    client.auth.getSession().then(({ data, error: authError }) => {
      if (!active) return;
      if (authError) setError('Sign-in could not be completed. Please try again.');
      setUser(data.session?.user ?? null);
      setReady(true);
      // OAuth callback codes/errors should not linger in the address bar.
      if (location.search.includes('code=') || location.search.includes('error')) history.replaceState(null, '', '/');
    }).catch(() => { if (active) { setError('Sign-in is unavailable. Please try again.'); setReady(true); } });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (active) { setUser(session?.user ?? null); setReady(true); }
    });
    if (new URLSearchParams(location.search).has('error') || location.hash.includes('error=')) {
      setError('GitHub sign-in was cancelled or could not be completed. You can try again.');
      history.replaceState(null, '', '/');
    }
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  async function signIn() {
    if (!client) return;
    setBusy(true); setError('');
    try {
      const { error } = await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.origin } });
      if (error) throw error;
    } catch { setError('GitHub sign-in is unavailable. Please try again.'); setBusy(false); }
  }
  async function signOut() {
    if (!client) return;
    setBusy(true); setError('');
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      setUser(null);
    } catch { setError('Could not sign out. Please try again.'); }
    finally { setBusy(false); }
  }
  return <div className="shell">
    <header><a className="wordmark" href="/">satchel</a><div className="header-actions">
      <button className="quiet" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? 'Dark' : 'Light'} mode</button>
      {user && <button className="quiet" disabled={busy} onClick={signOut}>Sign out</button>}
    </div></header>
    <main>
      {error && <p className="notice error" role="alert">{error}</p>}
      {!ready ? <p role="status">Opening your Satchel…</p> : user ? <Book key={user.id} /> :
        <section className="welcome">
          <div className="eyebrow">YOUR WORK, WITH YOU</div>
          <h1>A place for what<br />you want to remember.</h1>
          <p className="intro">Keep the decisions and details that make a project yours. Start with a note. Come back to it anywhere.</p>
          <button className="primary" disabled={!client || busy} onClick={signIn}>{busy ? 'Opening GitHub…' : 'Continue with GitHub'} <span aria-hidden="true">↗</span></button>
          {!client ? <p className="notice" role="status">This instance is awaiting account setup. Sign-in will be available once it is connected.</p> : <p className="muted fine">Sign in to your own book. Repository access is not requested.</p>}
          <div className="welcome-footer"><span className="rule" /><span className="eyebrow">A LITTLE LESS REPEATING YOURSELF.</span></div>
        </section>}
    </main>
    <footer>Satchel · Private pilot <span>Explicit saves. Yours to revise.</span></footer>
  </div>;
}

function Book() {
  const db = client!;
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [draft, setDraft] = useState('');
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [editing, setEditing] = useState<Memory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [projectId, setProjectId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let active = true;
    db.from('projects').select('id,name,brief').order('created_at').then(({ data, error }) => {
      if (!active) return;
      if (error) setError(errorMessage(error, 'load'));
      else { setProjects(data ?? []); setSelected(current => current || data?.[0]?.id || ''); }
      setLoading(false);
    });
    return () => { active = false; };
  }, [db, refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setMemories([]); setLoading(true);
    db.from('memories').select('id,project_id,body,revision,created_at,updated_at').eq('project_id', selected).order('updated_at', { ascending: false }).then(({ data, error }) => {
      if (!active) return;
      if (error) setError(errorMessage(error, 'load')); else setMemories(data ?? []);
      setLoading(false);
    });
    return () => { active = false; };
  }, [db, selected, refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  function changeDraft(value: string) { setDraft(value); setDraftId(crypto.randomUUID()); }
  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      const { data, error } = await db.rpc('create_project', { p_id: projectId, p_name: name.trim(), p_brief: brief.trim() }).single<Project>();
      if (error) throw error;
      if (!data) throw new Error('Missing project');
      setProjects(current => [...current.filter(p => p.id !== data.id), data]); setSelected(data.id);
      setName(''); setBrief(''); setProjectId(crypto.randomUUID()); setNotice('Project created.');
    });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      const result = editing
        ? await db.rpc('correct_memory', { p_id: editing.id, p_revision: editing.revision, p_body: draft.trim() }).single<Memory>()
        : await db.rpc('save_memory', { p_id: draftId, p_project_id: selected, p_body: draft.trim() }).single<Memory>();
      if (result.error) throw result.error;
      if (!result.data) throw new Error('Missing memory');
      setMemories(current => [result.data!, ...current.filter(m => m.id !== result.data!.id)]);
      setDraft(''); setDraftId(crypto.randomUUID()); setEditing(null); setNotice('Saved to your book.');
    });
  }
  async function remove(memory: Memory) {
    await run(async () => {
      const { data, error } = await db.from('memories').delete().eq('id', memory.id).eq('revision', memory.revision).select('id');
      if (error) throw error;
      if (!data?.length) throw { code: '40001' };
      setMemories(current => current.filter(m => m.id !== memory.id)); setDeleteTarget(null);
      if (editing?.id === memory.id) { setEditing(null); setDraft(''); }
      setNotice('Deleted from your book.');
    });
  }
  return <div className="book-layout">
    <aside><div className="eyebrow">YOUR PROJECTS</div>
      <nav aria-label="Projects">{projects.map(project => <button key={project.id} aria-current={selected === project.id ? 'page' : undefined} disabled={busy || Boolean(draft)} onClick={() => { setSelected(project.id); setEditing(null); setDeleteTarget(null); setNotice(''); setError(''); }}>{project.name}</button>)}</nav>
      <details><summary>New project</summary><form onSubmit={createProject}>
        <label>Project name<input required maxLength={100} value={name} disabled={busy} onChange={e => { setName(e.target.value); setProjectId(crypto.randomUUID()); }} /></label>
        <label>Brief <span className="muted">(optional)</span><textarea maxLength={1000} value={brief} disabled={busy} onChange={e => { setBrief(e.target.value); setProjectId(crypto.randomUUID()); }} /></label>
        <button className="primary" disabled={busy || !name.trim() || Boolean(draft)}>Create project</button>
      </form></details>
    </aside>
    <section className="book"><div className="book-heading"><div><div className="eyebrow">{projects.find(p => p.id === selected)?.name ?? 'YOUR FIRST PAGE'}</div><h1>The book.</h1></div><button className="quiet" disabled={busy || loading} onClick={() => { setError(''); setRefresh(n => n + 1); }}>Reload</button></div>
      {error && <p role="alert" className="notice error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {selected && <><p className="muted">{projects.find(p => p.id === selected)?.brief || 'Decisions and details worth carrying forward.'}</p>
        <form className="composer" onSubmit={save}><label>{editing ? 'Correct this memory' : 'Write something down'}<textarea required maxLength={4000} value={draft} disabled={busy} onChange={e => changeDraft(e.target.value)} placeholder="What should your next session know?" /></label>
          <div className="compose-actions"><span className="muted fine">{draft.length}/4000 · Explicit saves only</span><div>{(editing || draft) && <button type="button" className="quiet" disabled={busy} onClick={() => { setEditing(null); changeDraft(''); }}>Discard draft</button>}<button className="primary" disabled={busy || !draft.trim()}>{busy ? 'Working…' : editing ? 'Save correction' : 'Save memory'}</button></div></div>
        </form></>}
      {loading ? <p role="status">Loading your book…</p> : !selected ? <div className="empty"><h2>Begin with a project.</h2><p>Give an ongoing effort a name, then save its first decision. A repository is optional.</p></div> : memories.length === 0 ? <div className="empty"><h2>A fresh page.</h2><p>Only what you choose to save belongs here.</p></div> : <div>{memories.map(memory => <article key={memory.id}>
        <p className="memory-body">{memory.body}</p><div className="memory-meta"><span className="muted fine">Revision {memory.revision} · {new Date(memory.updated_at).toLocaleString()}</span><div><button className="quiet" disabled={busy || Boolean(draft)} onClick={() => { setEditing(memory); setDraft(memory.body); setError(''); }}>Correct</button><button className="quiet" disabled={busy} onClick={() => setDeleteTarget(memory)}>Delete</button></div></div>
        {deleteTarget?.id === memory.id && <div className="notice" role="group" aria-label="Confirm deletion"><p>Delete this memory from Satchel? Copies in previous chats or exports are unaffected.</p><button className="danger" disabled={busy} onClick={() => remove(memory)}>Delete memory</button> <button className="quiet" disabled={busy} onClick={() => setDeleteTarget(null)}>Keep it</button></div>}
      </article>)}</div>}
    </section>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
