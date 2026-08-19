// QuickAdd — the primary capture surface (BRIEF §3).
//
// Pinned to the top of every view. Live-parses input with lib/capture (chrono
// for dates) and shows a SINGLE quiet preview line under the bar with the
// resolved fields and the date ECHOED IN WORDS. Keyboard: Enter = add + clear +
// keep focus (rapid capture); Shift+Enter = add + open; Esc = blur. The `c` key
// elsewhere focuses this bar (wired in App via the forwarded ref).

import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { parseInput, previewLine } from '../lib/capture';
import { useStore } from '../store/store';

export interface QuickAddHandle {
  focus(): void;
}

export interface QuickAddProps {
  /** Open the command palette — the ⌘K hint calls this. */
  onOpenPalette?: () => void;
  /** Open the detail card for a just-added task (Shift+Enter = add AND open). */
  onOpen?: (id: string) => void;
  /** Surface a quiet notice (e.g. "add a few words, not just a tag"). */
  onNotice?: (message: string) => void;
}

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

export const QuickAdd = forwardRef<QuickAddHandle, QuickAddProps>(function QuickAdd(
  { onOpenPalette, onOpen, onNotice },
  ref,
): JSX.Element {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const addFromInput = useStore((s) => s.addFromInput);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  // Live preview: re-parse on every keystroke. Cheap enough for MVP.
  const preview = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return previewLine(parseInput(trimmed));
  }, [value]);

  function commit(open: boolean): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    // Guard the "just a tag / just a date" case — an empty title makes a
    // confusing blank row, so nudge instead of silently adding one.
    if (!parseInput(trimmed).title.trim()) {
      onNotice?.('Add a few words too — not just tags or a date.');
      return;
    }
    const id = addFromInput(trimmed, { open });
    if (id) {
      setValue('');
      // Enter: keep capturing (refocus the bar). Shift+Enter: add AND open the
      // new item's detail card (BRIEF §3). addFromInput already selected it.
      if (open) onOpen?.(id);
      else inputRef.current?.focus();
    }
  }

  return (
    <div className="rune-quickadd">
      <div className="rune-quickadd-field">
        <input
          ref={inputRef}
          className="rune-quickadd-input"
          type="text"
          value={value}
          placeholder="Add a task…  #tag  @context  !!!  friday 3pm  //note"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(e.shiftKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              inputRef.current?.blur();
            }
          }}
        />
        {onOpenPalette && (
          <button
            type="button"
            className="rune-qa-palette"
            title="Command palette"
            aria-label="Open the command palette"
            onClick={onOpenPalette}
          >
            {IS_MAC ? '⌘K' : 'Ctrl K'}
          </button>
        )}
      </div>
      {preview && <div className="rune-quickadd-preview">{preview}</div>}
    </div>
  );
});
