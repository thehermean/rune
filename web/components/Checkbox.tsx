// Checkbox — the one piece of chrome on a resting row.
//
// State glyphs (BRIEF §5 MVP): open = empty box, done = checked (accent), doing
// = half/▣, cancelled = strike box, deferred = arrow. The checkbox is a button
// so it is keyboard- and pointer-clickable; the accent is used here as one of
// its three sanctioned uses (the completion check).

import type { State } from '@core';
import { clsx } from 'clsx';

const GLYPH: Record<State, string> = {
  open: '○',
  done: '◉',
  doing: '◐',
  cancelled: '⊘',
  deferred: '›',
};

const LABEL: Record<State, string> = {
  open: 'open, mark done',
  done: 'done, reopen',
  doing: 'in progress',
  cancelled: 'cancelled',
  deferred: 'deferred',
};

export interface CheckboxProps {
  state: State;
  /** Toggle handler (open <-> done). */
  onToggle: () => void;
}

export function Checkbox({ state, onToggle }: CheckboxProps): JSX.Element {
  return (
    <button
      type="button"
      className={clsx('rune-checkbox', `is-${state}`)}
      aria-label={LABEL[state]}
      aria-pressed={state === 'done'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {GLYPH[state]}
    </button>
  );
}
