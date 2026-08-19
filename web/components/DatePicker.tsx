// DatePicker — point-and-click date entry (Pickers phase).
//
// LOCKED SIGNATURE (CONTRACTS Wave 5). `value` is the stored ISO ("" = none);
// `onCommit` receives a natural-language OR ISO string OR "" to clear — the
// store parses it (same path as setDue). PURE/presentational: it never imports
// the store, it only calls the onCommit prop.
//
// Three calm ways in, narrowest to widest: quick chips (Today / Tomorrow / This
// weekend / Next week / Clear) that compute an ISO via web/lib/dates and commit
// it; a native <input type="date"> for an exact day; and a small natural-language
// box ("e.g. friday, jul 10") whose raw text is handed to onCommit untouched
// (chrono parses it in the store). When a value is set we echo it in words.

import { useEffect, useRef, useState } from 'react';
import { addDays, nextMonday, nextSaturday } from 'date-fns';
import { echoWords, toISO, parseDateStrict } from '../lib/dates';

export interface DatePickerProps {
  label: string;
  /** The stored ISO date ("" = none). */
  value: string;
  /** Commit a natural-language OR ISO string, OR "" to clear. */
  onCommit: (input: string) => void;
  /** Called when the typed text can't be read as a date, INSTEAD of committing
   *  (the store would otherwise silently no-op). Lets the host toast a near-miss. */
  onInvalid?: (input: string) => void;
}

/** The quick chips. Each maps to an ISO computed at click time from `today`. */
const CHIPS: Array<{ label: string; iso: (today: Date) => string }> = [
  { label: 'Today', iso: (t) => toISO(t) },
  { label: 'Tomorrow', iso: (t) => toISO(addDays(t, 1)) },
  // "This weekend" = the coming Saturday; "Next week" = the coming Monday.
  { label: 'This weekend', iso: (t) => toISO(nextSaturday(t)) },
  { label: 'Next week', iso: (t) => toISO(nextMonday(t)) },
];

export function DatePicker({ label, value, onCommit, onInvalid }: DatePickerProps): JSX.Element {
  // Free-form natural-language draft, committed on blur/Enter.
  const [draft, setDraft] = useState('');
  const lastValue = useRef(value);
  // Clear the stale draft when the stored value changes (e.g. undo, switch task).
  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setDraft('');
    }
  }, [value]);

  // The native picker shows the stored ISO when it is a real ISO date; a
  // preserved-but-unparseable value (rare) leaves the calendar empty.
  const nativeValue = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  const echo = value ? echoWords(value) : '';

  function commitDraft(): void {
    const text = draft.trim();
    if (!text) return;
    // Validate here so an unreadable date never silently no-ops in the store's
    // setDue/setScheduled path — surface a near-miss notice instead. An ISO value
    // is always accepted; otherwise it must parse.
    const isIso = /^\d{4}-\d{2}-\d{2}$/.test(text);
    if (!isIso && parseDateStrict(text) === null) {
      onInvalid?.(text);
      return; // keep the draft so the user can fix it
    }
    onCommit(text);
    setDraft('');
  }

  return (
    <div className="rune-detail-field rune-picker">
      <span className="rune-detail-label">{label}</span>
      <span className="rune-dep-wrap">
        <span className="rune-detail-state">
          {CHIPS.map((c) => (
            <button
              key={c.label}
              type="button"
              className="rune-detail-state-opt"
              onClick={() => onCommit(c.iso(new Date()))}
            >
              {c.label}
            </button>
          ))}
          <button
            type="button"
            className="rune-detail-state-opt"
            disabled={!value}
            onClick={() => onCommit('')}
          >
            Clear
          </button>
        </span>

        <span className="rune-detail-datewrap">
          <input
            type="date"
            className="rune-detail-input rune-picker-input"
            value={nativeValue}
            onChange={(e) => onCommit(e.target.value)}
          />
          {echo && <span className="rune-detail-echo">{echo}</span>}
        </span>

        <input
          className="rune-detail-input rune-picker-input"
          value={draft}
          placeholder="e.g. friday, jul 10"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
        />
      </span>
    </div>
  );
}
