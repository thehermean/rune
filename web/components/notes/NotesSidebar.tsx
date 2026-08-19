// NotesSidebar — folders + note list, full-text search (server /api/notes/search
// over bodies), a tag browser, and the active-tag filter. Notes arrive
// pre-sorted (pinned first, then recent); we bucket by folder for display.

import { useEffect, useMemo, useState } from 'react';
import type { NoteMeta } from '../../lib/notes-api';
import { apiSearch } from '../../lib/notes-api';
import { useNotesStore } from '../../store/notes';

export function NotesSidebar(): JSX.Element {
  const notes = useNotesStore((s) => s.notes);
  const currentId = useNotesStore((s) => s.currentId);
  const open = useNotesStore((s) => s.open);
  const createNote = useNotesStore((s) => s.createNote);
  const activeTag = useNotesStore((s) => s.activeTag);
  const setActiveTag = useNotesStore((s) => s.setActiveTag);
  const setGraphOpen = useNotesStore((s) => s.setGraphOpen);

  const [q, setQ] = useState('');
  const [results, setResults] = useState<NoteMeta[] | null>(null);
  const [folderInput, setFolderInput] = useState<string | null>(null);

  // Full-text search hits the server (bodies), debounced. Empty query -> manifest.
  useEffect(() => {
    const t = q.trim();
    if (!t) { setResults(null); return; }
    const id = setTimeout(() => {
      void apiSearch(t).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24);
  }, [notes]);

  const base = results ?? notes;
  const filtered = useMemo(
    () => (activeTag ? base.filter((n) => n.tags.includes(activeTag)) : base),
    [base, activeTag],
  );

  const groups = useMemo(() => {
    const map = new Map<string, NoteMeta[]>();
    for (const n of filtered) {
      const key = n.folder || '';
      const list = map.get(key);
      if (list) list.push(n);
      else map.set(key, [n]);
    }
    const keys = [...map.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    return keys.map((k) => [k, map.get(k) as NoteMeta[]] as const);
  }, [filtered]);

  return (
    <aside className="rune-notes-sidebar">
      <div className="rune-notes-side-top">
        <span className="rune-notes-heading">Notes</span>
        <div className="rune-notes-side-actions">
          <button type="button" className="rune-chrome-btn" title="New note" onClick={() => void createNote('')}>+ Note</button>
          <button type="button" className="rune-chrome-btn" title="New folder" onClick={() => setFolderInput('')}>+ Folder</button>
          <button type="button" className="rune-chrome-btn" title="Graph view" onClick={() => setGraphOpen(true)}>Graph</button>
        </div>
      </div>

      <input className="rune-notes-search" type="text" placeholder="Search all notes…" value={q}
        spellCheck={false} aria-label="Search notes" onChange={(e) => setQ(e.target.value)} />

      {folderInput !== null && (
        <input autoFocus className="rune-notes-newfolder" type="text" placeholder="Folder name, then Enter" value={folderInput}
          onChange={(e) => setFolderInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { const f = folderInput.trim(); if (f) void createNote(f); setFolderInput(null); }
            else if (e.key === 'Escape') setFolderInput(null);
          }}
          onBlur={() => setFolderInput(null)} />
      )}

      {(activeTag || allTags.length > 0) && (
        <div className="rune-notes-tags">
          {activeTag && (
            <button type="button" className="rune-tag-chip is-active" onClick={() => setActiveTag(null)}>
              #{activeTag} ✕
            </button>
          )}
          {!activeTag && allTags.map(([t, n]) => (
            <button key={t} type="button" className="rune-tag-chip" onClick={() => setActiveTag(t)}>
              #{t} <span className="rune-tag-count">{n}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rune-notes-list" role="list">
        {filtered.length === 0 && (
          <p className="rune-notes-empty-list">{q || activeTag ? 'No notes match.' : 'No notes yet — press + Note.'}</p>
        )}
        {groups.map(([folder, items]) => (
          <div key={folder || '(root)'} className="rune-notes-group">
            {folder && <div className="rune-notes-folder">{folder}</div>}
            {items.map((n) => (
              <button key={n.id} type="button" role="listitem"
                className={`rune-note-row${n.id === currentId ? ' is-active' : ''}`}
                onClick={() => void open(n.id)}>
                <span className="rune-note-row-head">
                  {n.pinned && <span className="rune-note-pin" aria-label="Pinned">📌</span>}
                  <span className="rune-note-title">{n.title}</span>
                  <span className="rune-note-date">{shortDate(n.updatedAt)}</span>
                </span>
                <span className="rune-note-snippet">{n.snippet || 'No additional text'}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
