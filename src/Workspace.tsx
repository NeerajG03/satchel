import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorMessage } from './client';
import { createMemoryRepository } from './features/memories/repository';
import { EMPTY_CONTENT, PERSONAL_SCOPE, replaceSummary, scopeProjectId, type Memory, type MemorySummary, type MemoryScope, type MemoryContent } from './features/memories/model';
import { MemoryEditor } from './features/memories/MemoryEditor';
import { MemoryList } from './features/memories/MemoryList';
import { createProjectRepository, type Project } from './features/projects/repository';
import { ScopeSidebar } from './features/projects/ScopeSidebar';

export function Workspace({ db }: { db: SupabaseClient }) {
  const memoryStore = useMemo(() => createMemoryRepository(db), [db]);
  const projectStore = useMemo(() => createProjectRepository(db), [db]);
  const [scope, setScope] = useState<MemoryScope>(PERSONAL_SCOPE);
  const [projects, setProjects] = useState<Project[]>([]);
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [content, setContent] = useState<MemoryContent>(EMPTY_CONTENT);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [editing, setEditing] = useState<Memory | null>(null);
  const [expanded, setExpanded] = useState<Memory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemorySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [memoriesLoading, setMemoriesLoading] = useState(true);
  const [projectError, setProjectError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const hasDraft = Boolean(content.name || content.description || content.more_info);
  const project = scope.kind === 'project' ? projects.find(p => p.id === scope.projectId) : undefined;
  const destination = scope.kind === 'personal' ? 'For me' : project?.name ?? 'Project';

  useEffect(() => {
    let active = true;
    setProjectsLoading(true); setProjectError('');
    projectStore.list().then(data => { if (active) setProjects(data); })
      .catch(error => { if (active) setProjectError(errorMessage(error, 'load')); })
      .finally(() => { if (active) setProjectsLoading(false); });
    return () => { active = false; };
  }, [projectStore, refresh]);

  useEffect(() => {
    let active = true;
    setMemoriesLoading(true); setLoadError(''); setMemories([]); setExpanded(null);
    memoryStore.list(scope).then(data => { if (active) setMemories(data); })
      .catch(error => { if (active) setLoadError(errorMessage(error, 'load')); })
      .finally(() => { if (active) setMemoriesLoading(false); });
    return () => { active = false; };
  }, [memoryStore, scope, refresh]);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true); setError(''); setNotice('');
    try { await action(); return true; }
    catch (error) { setError(errorMessage(error)); return false; }
    finally { setBusy(false); }
  }
  function clearDraft() { setContent(EMPTY_CONTENT); setEditing(null); setDraftId(crypto.randomUUID()); }
  function chooseScope(next: MemoryScope) {
    if (scopeProjectId(next) === scopeProjectId(scope)) return;
    setScope(next); setMemories([]); setMemoriesLoading(true); setExpanded(null);
    setDeleteTarget(null); setEditing(null); setError(''); setNotice('');
  }
  function read(memory: MemorySummary, edit = false) {
    return run(async () => {
      const current = await memoryStore.read(memory);
      setExpanded(current); setMemories(items => replaceSummary(items, current));
      if (edit) { setEditing(current); setContent({ name: current.name, description: current.description, more_info: current.more_info }); }
    });
  }
  function save() {
    return run(async () => {
      const saved = editing ? await memoryStore.correct(editing, content) : await memoryStore.save(scope, draftId, content);
      setMemories(items => replaceSummary(items, saved)); setExpanded(null); clearDraft(); setNotice('Saved to your book.');
    });
  }
  function remove(memory: MemorySummary) {
    return run(async () => {
      await memoryStore.remove(memory);
      setMemories(items => items.filter(item => item.id !== memory.id)); setDeleteTarget(null);
      if (editing?.id === memory.id) clearDraft();
      if (expanded?.id === memory.id) setExpanded(null);
      setNotice('Deleted from your book.');
    });
  }
  function createProject(id: string, name: string, brief: string) {
    return run(async () => {
      const created = await projectStore.create(id, name, brief);
      setProjects(items => [...items.filter(item => item.id !== created.id), created]);
      chooseScope({ kind: 'project', projectId: created.id }); setNotice('Project created.');
    });
  }

  return <div className="book-layout">
    <ScopeSidebar projects={projects} scope={scope} busy={busy || projectsLoading} navigationLocked={busy || hasDraft}
      onSelect={chooseScope} onCreate={createProject} />
    <section className="book">
      <div className="book-heading"><div><div className="eyebrow">{destination}</div><h1>The book.</h1></div>
        <button className="quiet" disabled={busy || projectsLoading || memoriesLoading}
          onClick={() => { setError(''); setNotice(''); setRefresh(value => value + 1); }}>Reload</button></div>
      {projectError && <p role="alert" className="notice error">Projects: {projectError}</p>}
      {loadError && <p role="alert" className="notice error">{loadError}</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      <p className="muted">{scope.kind === 'personal' ? 'Preferences and details that apply across your work. No project needed.' : project?.brief || 'Decisions and details worth carrying forward.'}</p>
      <MemoryEditor content={content} editing={Boolean(editing)} busy={busy || memoriesLoading} destination={destination}
        onChange={value => { setContent(value); setDraftId(crypto.randomUUID()); }} onDiscard={clearDraft} onSave={() => void save()} />
      {memoriesLoading ? <p role="status">Loading your book…</p> : !loadError && memories.length === 0 ?
        <div className="empty"><h2>{scope.kind === 'personal' ? 'Start with something about you.' : 'A fresh page.'}</h2>
          <p>{scope.kind === 'personal' ? 'Save a preference or detail you want to carry between conversations.' : 'Only what you choose to save belongs here.'}</p></div> :
        <MemoryList memories={memories} expanded={expanded} deleteTarget={deleteTarget} busy={busy} hasDraft={hasDraft}
          onRead={memory => void read(memory)} onHide={() => setExpanded(null)} onCorrect={memory => void read(memory, true)}
          onAskDelete={setDeleteTarget} onDelete={memory => void remove(memory)} />}
    </section>
  </div>;
}
