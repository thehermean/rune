// SourceView (Wave 4) — the full-height raw `.rune` editor.
//
// A plain controlled <textarea> (NO CodeMirror) bound to the canonical `.rune`
// text in the store: it reads `useStore(s => s.text)` and writes every keystroke
// through `useStore(s => s.setText)`, which reparses + autosaves + is undoable.
// Because the store is the single source of truth, edits here are instantly
// reflected in every other view, and undo/redo (Cmd+Z) work uniformly.
//
// Below the editor sits a QUIET live parse-status line: the parser never throws
// (every line classifies to SOME node), so "status" means a calm task count and,
// when a line is raw text that isn't a recognised construct (task / heading /
// note / comment / blank), a gentle "looks unparseable" hint pointing at the
// first such line. No chips, no badges — tokens only, tabular numerals.
//
// Syntax highlighting is intentionally NOT done here (see risks); a styled
// <textarea> keeps the surface dependency-free and uncluttered.

import { useMemo, useRef } from 'react';
import { classifyLine } from '@core';
import { useStore } from '../store/store';

/** A pause (ms) between keystrokes that starts a NEW undo step. Typing bursts
 *  within this window coalesce into one; a blur also closes the current burst. */
const SOURCE_EDIT_IDLE_MS = 2000;

export interface SourceViewProps {
  /** Open the detail card for `id` (parity with the other views' onOpen). */
  onOpen?: (id: string) => void;
}

interface ParseStatus {
  /** Number of `- [ ]` task lines in the current text. */
  taskCount: number;
  /** 1-based line number of the first line that reads as stray raw text, or 0. */
  unparseableLine: number;
}

/** Classify the current text line-by-line into a calm status summary.
 *  A "text" node is a line the grammar didn't recognise as any known construct;
 *  a fully blank document (just "") is fine and reports nothing. */
function statusOf(text: string): ParseStatus {
  const lines = text.split('\n');
  let taskCount = 0;
  let unparseableLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const node = classifyLine(lines[i]);
    if (node.type === 'task') taskCount++;
    else if (node.type === 'text' && unparseableLine === 0) {
      unparseableLine = i + 1; // 1-based for human reading
    }
  }
  return { taskCount, unparseableLine };
}

export function SourceView(_props: SourceViewProps): JSX.Element {
  const text = useStore((s) => s.text);
  const setText = useStore((s) => s.setText);

  // Coalesce a burst of keystrokes into ONE undo step instead of one-per-key
  // (which used to blow away HISTORY_LIMIT). The key stays stable across a burst;
  // a >2s idle gap or a blur mints a fresh key so separate editing sessions stay
  // separate undo steps.
  const coalesceKeyRef = useRef<string | null>(null);
  const lastEditAtRef = useRef(0);

  const onChange = (value: string): void => {
    const now = Date.now();
    if (coalesceKeyRef.current === null || now - lastEditAtRef.current > SOURCE_EDIT_IDLE_MS) {
      coalesceKeyRef.current = `source-edit:${now}`;
    }
    lastEditAtRef.current = now;
    setText(value, { coalesceKey: coalesceKeyRef.current });
  };

  // Closing the editing session: the next keystroke starts a new undo step.
  const onBlur = (): void => {
    coalesceKeyRef.current = null;
  };

  const status = useMemo(() => statusOf(text), [text]);

  // The status line reuses the calm `.rune-source-stub` look (mute, meta size).
  // It is styled inline with token vars because this file owns no CSS; tokens
  // only, no hard-coded values. Counts inherit tabular-nums from the global body.
  const statusStyle: React.CSSProperties = {
    marginTop: 'var(--space-3)',
    fontSize: 'var(--size-meta)',
    lineHeight: 'var(--lh-meta)',
    color: 'var(--mute)',
  };
  const hintStyle: React.CSSProperties = { color: 'var(--danger)' };

  const tasksLabel = status.taskCount === 1 ? 'task' : 'tasks';

  return (
    <div className="rune-source">
      <textarea
        className="rune-source-editor"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label="Raw .rune source"
      />
      <p style={statusStyle} aria-live="polite">
        {status.taskCount} {tasksLabel}
        {status.unparseableLine > 0 && (
          <>
            {' · '}
            <span style={hintStyle}>unparseable line {status.unparseableLine}</span>
          </>
        )}
      </p>
    </div>
  );
}
