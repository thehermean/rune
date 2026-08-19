// RecurrencePicker — point-and-click recurrence (the Pickers phase).
//
// LOCKED SIGNATURE (CONTRACTS Wave 5). `rule` is the english recurrence rule
// ("" = none); `rolling` distinguishes recur: (fixed, rolling=false) from
// recur!: (rolling, rolling=true). `onCommit(rule, rolling)` sets/clears both.
//
// PURE / presentational: this component never touches the store. It offers a
// row of quiet presets (None / Daily / Weekly / Monthly / Yearly / Weekdays)
// that map to the english strings the engine understands, plus a Custom text
// field for any other english rule (e.g. "every other monday"). A small
// fixed/rolling toggle picks recur: vs recur!:. The active selection is shown.

import { useEffect, useRef, useState } from 'react';
import { nextOccurrence } from '@core/recur';
import { toISO } from '../lib/dates';

export interface RecurrencePickerProps {
  /** The english recurrence rule ("" = none). */
  rule: string;
  /** true = recur!: (rolls from completion); false = recur: (fixed cadence). */
  rolling: boolean;
  /** Set/clear the recurrence; empty rule clears it. */
  onCommit: (rule: string, rolling: boolean) => void;
  /** Called when a typed custom rule can't be read by the engine, INSTEAD of
   *  committing it (setRecurrence would otherwise store a rule that never spawns
   *  a next occurrence). Lets the host toast a near-miss. */
  onInvalid?: (rule: string) => void;
}

/** Quiet presets mapped to the english rules the recur engine understands.
 *  `None` is the empty rule (clears both recur keys). `Custom` has no fixed
 *  rule — it defers to whatever the user types in the text field. */
const PRESETS: Array<{ key: string; label: string; rule: string }> = [
  { key: 'none', label: 'None', rule: '' },
  { key: 'daily', label: 'Daily', rule: 'every day' },
  { key: 'weekly', label: 'Weekly', rule: 'every week' },
  { key: 'monthly', label: 'Monthly', rule: 'every month' },
  { key: 'yearly', label: 'Yearly', rule: 'every year' },
  { key: 'weekdays', label: 'Weekdays', rule: 'every weekday' },
];

/** Alternate english spellings a stored rule may use that still map to a preset
 *  (so "daily" lights Daily, not Custom). Compared case-insensitively. */
const PRESET_ALIASES: Record<string, string> = {
  '': 'none',
  'every day': 'daily',
  daily: 'daily',
  'every week': 'weekly',
  weekly: 'weekly',
  'every month': 'monthly',
  monthly: 'monthly',
  'every year': 'yearly',
  yearly: 'yearly',
  annually: 'yearly',
  'every weekday': 'weekdays',
};

/** Which preset (if any) the current rule matches — else 'custom'. */
function presetKeyFor(rule: string): string {
  return PRESET_ALIASES[rule.trim().toLowerCase()] ?? 'custom';
}

export function RecurrencePicker({ rule, rolling, onCommit, onInvalid }: RecurrencePickerProps): JSX.Element {
  const activeKey = presetKeyFor(rule);
  const isCustom = activeKey === 'custom';

  // The custom text field is its own draft so typing doesn't commit per-keystroke.
  const [draft, setDraft] = useState(isCustom ? rule : '');
  const lastRule = useRef(rule);
  useEffect(() => {
    // Re-seed the draft when the rule changes from outside (undo, switch task).
    if (rule !== lastRule.current) {
      lastRule.current = rule;
      setDraft(presetKeyFor(rule) === 'custom' ? rule : '');
    }
  }, [rule]);

  function commitCustom(): void {
    const clean = draft.trim();
    if (clean === rule) return;
    // A non-empty rule the engine can't expand would store silently and never
    // produce a next occurrence — validate first and surface a near-miss instead.
    if (clean && nextOccurrence(clean, toISO(new Date())) === null) {
      onInvalid?.(clean);
      return; // keep the draft so the user can fix it
    }
    onCommit(clean, rolling);
  }

  return (
    <div className="rune-detail-field rune-picker">
      <span className="rune-detail-label">Repeats</span>
      <span className="rune-recur-wrap" style={{ flexDirection: 'column' }}>
        <span className="rune-detail-state">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`rune-detail-state-opt${activeKey === p.key ? ' is-active' : ''}`}
              onClick={() => {
                if (p.key === 'none') onCommit('', false);
                else onCommit(p.rule, rolling);
              }}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className={`rune-detail-state-opt${isCustom ? ' is-active' : ''}`}
            title="Type any english rule, e.g. every other monday"
            onClick={() => {
              // Focus the custom field; nothing commits until the user types.
              if (!isCustom && draft.trim()) onCommit(draft.trim(), rolling);
            }}
          >
            Custom
          </button>

          {/* The rolling toggle is only meaningful once a rule exists. */}
          <button
            type="button"
            className={`rune-recur-rolling${rolling ? ' is-active' : ''}`}
            disabled={rule.trim() === ''}
            title={
              rolling
                ? 'Rolling: next occurrence counts from completion (recur!)'
                : 'Fixed: next occurrence follows the planned cadence (recur)'
            }
            onClick={() => {
              if (rule.trim() === '') return;
              onCommit(rule.trim(), !rolling);
            }}
          >
            {rolling ? 'from completion' : 'fixed'}
          </button>
        </span>

        <input
          className="rune-detail-input rune-picker-input"
          value={draft}
          placeholder="custom rule, e.g. every other monday"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitCustom}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </span>
    </div>
  );
}
