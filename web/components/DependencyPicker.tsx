// DependencyPicker — pick task dependencies by TITLE, never by typing ^ids.
//
// LOCKED SIGNATURE (CONTRACTS Wave 5). `value` is the current `after:` id list;
// `options` are the candidate tasks ({ id, title }); `onCommit` replaces the id
// list. PURE/presentational — it only calls `onCommit`; it never touches the
// store.
//
// UX: the current dependencies show by TITLE (each id looked up in `options`),
// each with a remove ✕ that commits the list without that id. A quiet search
// input filters the remaining candidates by title (case-insensitive, excluding
// what's already selected); clicking a result — or pressing Enter on the top
// match — adds its id. A raw ^id is never the primary affordance; a faint id
// hint rides along on the row/result title attribute only.

import { useMemo, useState } from 'react';

export interface DependencyPickerProps {
  /** Current `after:` dependency ids. */
  value: string[];
  /** Candidate tasks the user can depend on, identified by title. */
  options: Array<{ id: string; title: string }>;
  /** Replace the dependency id list. */
  onCommit: (ids: string[]) => void;
}

export function DependencyPicker({ value, options, onCommit }: DependencyPickerProps): JSX.Element {
  const [query, setQuery] = useState('');

  const titleOfId = (id: string): string => options.find((o) => o.id === id)?.title || id;

  // Candidates: real-id options not already selected, filtered by title.
  // (Self-exclusion: the inspector already drops the current task from options,
  // but guard here too so a stray self-id can never be offered.)
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        o.id &&
        !value.includes(o.id) &&
        (q === '' || (o.title || '').toLowerCase().includes(q)),
    );
  }, [options, value, query]);

  function remove(id: string): void {
    onCommit(value.filter((d) => d !== id));
  }

  function add(id: string): void {
    if (!id || value.includes(id)) return;
    onCommit([...value, id]);
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const top = matches[0];
      if (top) add(top.id);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  }

  return (
    <div className="rune-detail-field rune-picker">
      <span className="rune-detail-label">After</span>
      <span className="rune-dep-wrap">
        {value.length > 0 && (
          <ul className="rune-dep-list">
            {value.map((id) => (
              <li key={id} className="rune-dep-row">
                <span className="rune-dep-title" title={`^${id}`}>
                  {titleOfId(id)}
                </span>
                <button
                  type="button"
                  className="rune-dep-remove"
                  aria-label={`Remove dependency ${titleOfId(id)}`}
                  title="Remove"
                  onClick={() => remove(id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <input
          className="rune-detail-input rune-picker-input"
          type="text"
          value={query}
          placeholder="depends on…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search tasks to depend on"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {query.trim() !== '' &&
          (matches.length > 0 ? (
            <ul className="rune-dep-list">
              {matches.map((o, i) => (
                <li key={o.id} className="rune-dep-row">
                  <button
                    type="button"
                    className="rune-dep-add rune-dep-title"
                    title={`^${o.id}`}
                    onClick={() => add(o.id)}
                  >
                    {o.title || o.id}
                    {i === 0 ? ' ↵' : ''}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <span className="rune-dep-empty">no matching tasks</span>
          ))}
      </span>
    </div>
  );
}
