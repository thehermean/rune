// SelectionBar — the bulk-edit action bar.
//
// Appears fixed at the bottom whenever 2+ tasks are selected (shift-click a
// range, or ctrl/cmd-click to toggle individual rows). Each verb folds a
// single-task transform over the whole set in ONE undo step via the store's
// *Many actions; the .rune file stays canonical — this bar only issues actions.
//
// Fields: priority (set !/!!/!!! or clear), due date (natural language or ISO;
// empty clears), and add-tag. Done/open, delete and indent live in the ⌘K
// palette (and the checkbox / Backspace), so they stay off this bar.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';

const PRIORITIES: Array<{ level: number; label: string; title: string }> = [
  { level: 1, label: '!', title: 'Priority !' },
  { level: 2, label: '!!', title: 'Priority !!' },
  { level: 3, label: '!!!', title: 'Priority !!!' },
  { level: 0, label: '·', title: 'Clear priority' },
];

export function SelectionBar({
  onNotice,
}: {
  onNotice: (msg: string) => void;
}): JSX.Element | null {
  const selectedIds = useStore((s) => s.selectedIds);
  const setPriorityMany = useStore((s) => s.setPriorityMany);
  const setDueMany = useStore((s) => s.setDueMany);
  const addTagMany = useStore((s) => s.addTagMany);
  const clearSelection = useStore((s) => s.clearSelection);
  const selectMode = useStore((s) => s.selectMode);

  const [mode, setMode] = useState<null | 'due' | 'tag'>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const count = selectedIds.length;

  // Any change in how many rows are selected collapses the inline input — its
  // half-typed value never belongs to a different set than the one it opened on.
  useEffect(() => {
    setMode(null);
    setValue('');
  }, [count]);

  useEffect(() => {
    if (!mode) return undefined;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  // Shown for any 2+ selection, or whenever touch select mode is active (so a
  // single-row long-press already surfaces the bar + its Done exit).
  if (count < 2 && !selectMode) return null;
  const ids = selectedIds;

  function apply(): void {
    const v = value.trim();
    if (mode === 'due') {
      if (!setDueMany(ids, v)) {
        onNotice('Couldn’t read that date');
        return; // keep the input open so the near-miss can be corrected
      }
      onNotice(v === '' ? `Cleared due on ${ids.length}` : `Due set on ${ids.length}`);
    } else if (mode === 'tag') {
      const t = v.replace(/^#/, '').trim();
      if (t) {
        addTagMany(ids, t);
        onNotice(`#${t} added to ${ids.length}`);
      }
    }
    setMode(null);
    setValue('');
  }

  return (
    <div className="rune-selbar" role="toolbar" aria-label={`${count} tasks selected`}>
      <span className="rune-selbar-count">{count} selected</span>

      {mode === null ? (
        <>
          <span className="rune-selbar-group" aria-label="Set priority on selected">
            <span className="rune-selbar-label">Priority</span>
            {PRIORITIES.map((p) => (
              <button
                key={p.level}
                type="button"
                className="rune-selbar-btn"
                title={p.title}
                onClick={() => setPriorityMany(ids, p.level)}
              >
                {p.label}
              </button>
            ))}
          </span>
          <button type="button" className="rune-selbar-btn" onClick={() => setMode('due')}>
            Due…
          </button>
          <button type="button" className="rune-selbar-btn" onClick={() => setMode('tag')}>
            #tag…
          </button>
        </>
      ) : (
        <input
          ref={inputRef}
          className="rune-selbar-input"
          type="text"
          value={value}
          placeholder={
            mode === 'due'
              ? 'Due: friday · 2026-07-20 · empty clears'
              : 'Tag to add (no #)'
          }
          spellCheck={false}
          autoComplete="off"
          aria-label={mode === 'due' ? 'Due date for selected tasks' : 'Tag to add to selected tasks'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setMode(null);
              setValue('');
            }
          }}
          onBlur={() => {
            setMode(null);
            setValue('');
          }}
        />
      )}

      <button
        type="button"
        className="rune-selbar-btn rune-selbar-clear"
        title={selectMode ? 'Done — leave select mode' : 'Clear selection'}
        aria-label={selectMode ? 'Done' : 'Clear selection'}
        onClick={() => clearSelection()}
      >
        {selectMode ? 'Done' : 'Clear'}
      </button>
    </div>
  );
}
