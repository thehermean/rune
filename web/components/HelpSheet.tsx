// HelpSheet — the '?' shortcuts + capture-grammar sheet (first-sprint UX).
//
// Progressive disclosure: no always-on chrome. Opened by '?' (and closeable via
// Esc / backdrop). Reuses the .rune-modal* chrome; the key→action and
// token→meaning lists are a simple two-column grid.

import { Fragment, useEffect, useRef } from 'react';
import { useModalScope } from '../lib/modalScope';
import { useModalFocus } from '../lib/useModalFocus';

export interface HelpSheetProps {
  open: boolean;
  onClose: () => void;
}

const MOD =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)
    ? '⌘'
    : 'Ctrl';

const SHORTCUTS: Array<[string, string]> = [
  ['c', 'Add a task (focus the quick-add bar)'],
  ['/', 'Filter the document (same grammar as capture; Esc clears)'],
  ['j / k · ↑ / ↓', 'Move the selection'],
  ['Shift+J / Shift+K · shift-click', 'Extend the selection (bulk verbs apply)'],
  ['⌘/Ctrl-click · long-press (touch)', 'Toggle a row into the selection (select mode)'],
  ['Space / Enter', 'Complete / uncomplete the selected task(s)'],
  ['e', 'Edit the selected task inline'],
  ['o · click', 'Open the task inspector'],
  ['Tab / Shift+Tab', 'Indent / outdent (make or promote a sub-task)'],
  ['Shift+Enter', 'Add a sub-task under the selection'],
  [`${MOD}+↑ / ${MOD}+↓`, 'Reorder the selected task'],
  ['Backspace / Delete', 'Delete the selected task (with Undo)'],
  [`${MOD}+Z / ${MOD}+Shift+Z`, 'Undo / redo'],
  [`${MOD}+K`, 'Command palette'],
  ['?', 'Show this help'],
  ['Esc', 'Close / clear the selection'],
];

const GRAMMAR: Array<[string, string]> = [
  ['#tag', 'a tag — nest projects with a slash, e.g. #work/release'],
  ['@context', 'a context: a place, tool, or person'],
  ['! !! !!!', 'priority (or type p1 / p2 / p3)'],
  ['friday · tomorrow 3pm · jul 10', 'a due date, in plain words'],
  ['every monday · every 2 weeks', 'a recurring due date'],
  ['due … / start …', 'force the next phrase to be a date (e.g. due april)'],
  ['//note', 'a description for the task'],
  ['paste a link', 'attaches it to the task'],
];

export function HelpSheet({ open, onClose }: HelpSheetProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);

  // Own the keyboard while open + trap/restore focus (WCAG 2.4.3 / 2.1.2).
  useModalScope(open);
  useModalFocus(open, panelRef);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="rune-modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="rune-modal rune-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts and capture grammar"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="rune-modal-title">Keyboard shortcuts</p>
        <div className="rune-help-grid">
          {SHORTCUTS.map(([k, d]) => (
            <Fragment key={k}>
              <span className="rune-help-key">{k}</span>
              <span className="rune-help-desc">{d}</span>
            </Fragment>
          ))}
        </div>

        <div className="rune-help-section">
          <p className="rune-help-heading">Quick-add grammar</p>
          <div className="rune-help-grid">
            {GRAMMAR.map(([t, d]) => (
              <Fragment key={t}>
                <span className="rune-help-key rune-help-token">{t}</span>
                <span className="rune-help-desc">{d}</span>
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
