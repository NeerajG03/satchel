import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { PERSONAL_SCOPE, scopeProjectId, type MemoryScope } from '../features/memories/model';
import type { Project } from '../features/projects/repository';
import { scopeName } from '../app/scope';

type Props = {
  scope: MemoryScope; projects: Project[]; counts?: Record<string, number>;
  locked?: string; onChange: (scope: MemoryScope) => void; onNewProject?: () => void;
};

export function ScopePicker({ scope, projects, counts, locked, onChange, onNewProject }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = projects.filter(project => !needle || project.name.toLowerCase().includes(needle));
    const personal = !needle || 'for me'.includes(needle) ? [PERSONAL_SCOPE] : [];
    return [...personal, ...matches.map(project => ({ kind: 'project', projectId: project.id } as MemoryScope))];
  }, [projects, query]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    function away(event: MouseEvent) { if (!root.current?.contains(event.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  function choose(next: MemoryScope) { setOpen(false); setQuery(''); onChange(next); }
  function onKey(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(value => Math.min(value + 1, options.length - 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(value => Math.max(value - 1, 0)); }
    if (event.key === 'Enter') { event.preventDefault(); const pick = options[cursor]; if (pick) choose(pick); }
  }
  function countText(option: MemoryScope) {
    if (option.kind === 'personal') return 'applies everywhere';
    const n = counts?.[option.projectId];
    if (n === undefined) return '';
    return n === 0 ? 'empty' : `${n} memories`;
  }

  function onBlur(event: React.FocusEvent) { if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }

  return <div className="picker col" ref={root} style={{ gap: 4 }} onBlur={onBlur}>
    <button type="button" className="btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      disabled={Boolean(locked)} onClick={() => setOpen(value => !value)}>
      In {scopeName(scope, projects)} ▾
    </button>
    {locked && <span className="fine muted">{locked}</span>}
    {open && <div className="drop" onKeyDown={onKey}>
      <input ref={input} className="field" placeholder="Find a project" value={query} aria-label="Find a project"
        onChange={event => { setQuery(event.target.value); setCursor(0); }} />
      <div role="listbox" id={listId} aria-label="Scope" className="col" style={{ gap: 2 }}>
        {options.map((option, index) => {
          const selected = scopeProjectId(option) === scopeProjectId(scope);
          const name = scopeName(option, projects);
          const count = countText(option);
          return <button type="button" role="option" key={scopeProjectId(option) ?? 'me'} aria-selected={selected}
            className={`option ${index === cursor ? 'focus' : ''}`} onClick={() => choose(option)} onMouseEnter={() => setCursor(index)}>
            <span>{name}</span>
            <span className={`fine ${count === 'empty' ? '' : 'muted'}`} style={count === 'empty' ? { color: 'var(--amber)' } : undefined}>{count}</span>
          </button>;
        })}
        {options.length === 0 && <span className="fine muted" style={{ padding: '6px 12px' }}>Nothing matches “{query}”.</span>}
      </div>
      {onNewProject && <><hr className="hr" /><button type="button" className="option" onClick={() => { setOpen(false); onNewProject(); }}><span>New project</span><span className="muted">+</span></button></>}
    </div>}
  </div>;
}
