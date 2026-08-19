// Row — one task line: Checkbox + title text + inline Meta.
//
// At rest a row is text + a checkbox (BRIEF principle 3). Row chrome (the
// delete control) appears only on hover/:focus-within. Completed/cancelled rows
// render faint with a strike; the check-off strike is drawn left-to-right via
// CSS (the one signature micro-delight), gated on prefers-reduced-motion.
//
// Inline edit: when `editing` is true the row body becomes a single text input
// pre-filled with the canonical body (tokens included, WITHOUT the `- [x] `
// prefix and WITHOUT the trailing `^id`), with a live quick-add-style preview.
// Enter or blur commits via onEditCommit; Esc cancels via onEditCancel.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskNode } from '@core';
import { titleOf } from '@core';
import { clsx } from 'clsx';
import { Checkbox } from './Checkbox';
import { Meta } from './Meta';
import { parseInput, previewLine } from '../lib/capture';
import { useStore } from '../store/store';
import { attachmentsFromTransfer } from '../lib/attach';

/** Human-readable state words folded into the row's accessible name. */
const STATE_LABEL: Record<TaskNode['state'], string> = {
  open: 'to do',
  done: 'done',
  doing: 'in progress',
  cancelled: 'cancelled',
  deferred: 'deferred',
};

/** dataTransfer type marking an in-app row-reorder drag — distinct from a file /
 *  URL drag (which attaches). Only the PRESENCE of this type is readable during
 *  dragover; the value (the dragged task id) is available on drop. */
const REORDER_MIME = 'application/x-rune-task';

/** Long-press duration + finger-travel tolerance for entering touch select
 *  mode. Past the tolerance the gesture is a scroll, not a press. */
const LONG_PRESS_MS = 500;
const LP_MOVE_TOL = 10;

export interface RowProps {
  task: TaskNode;
  selected: boolean;
  now?: Date;
  onSelect: (id: string | null) => void;
  /** Shift-click: extend the selection range from the anchor to this row. When
   *  provided, a shift-click never opens the inspector. */
  onSelectRange?: (id: string) => void;
  onToggle: (id: string) => void;
  /** Open the detail card for this row (the `o` action). */
  onOpen?: (id: string) => void;
  /** Enter inline edit for this row (the `e` action / double-click). */
  onEdit?: (id: string) => void;
  /** Delete this row (the hover trash control / Backspace). */
  onDelete?: (id: string) => void;
  /** True when THIS row is in inline-edit mode. */
  editing?: boolean;
  /** Commit the edited body string (no prefix, no id). */
  onEditCommit?: (id: string, body: string) => void;
  /** Cancel inline edit without committing. */
  onEditCancel?: () => void;
  /** Drag-reorder: move `sourceId`'s block before/after this row's task. When
   *  provided, the row shows a drag grip and accepts reorder drops. Omitted
   *  while filtering/sorting (reordering a derived view is meaningless). */
  onReorder?: (sourceId: string, targetId: string, place: 'before' | 'after') => void;
}

/** The editable body of a task: every token in order, WITHOUT the `- [x] `
 *  prefix and WITHOUT the trailing `^id`. Built from segments so it matches the
 *  canonical serialized form. */
export function editableBody(task: TaskNode): string {
  return task.segments.map((s) => s.raw).join(' ').trim();
}

export function Row({
  task,
  selected,
  now,
  onSelect,
  onSelectRange,
  onToggle,
  onOpen,
  onEdit,
  onDelete,
  editing = false,
  onEditCommit,
  onEditCancel,
  onReorder,
}: RowProps): JSX.Element {
  const id = task.id;
  const title = titleOf(task);
  const struck = task.state === 'done' || task.state === 'cancelled';
  const addAttachment = useStore((s) => s.addAttachment);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectMode = useStore((s) => s.selectMode);
  const enterSelectMode = useStore((s) => s.enterSelectMode);
  const [dropping, setDropping] = useState(false);
  // The edge a reorder drag is hovering over (top/bottom of this row), or null.
  const [dropEdge, setDropEdge] = useState<'before' | 'after' | null>(null);
  // Long-press (touch) enters select mode; these track the pending press.
  const lpTimer = useRef<number | null>(null);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  // Pointer-events drag-to-reorder (touch): pick up via the grip, hit-test the
  // row under the finger, commit on release. Separate from the desktop HTML5
  // drag path so neither regresses the other.
  const dragRef = useRef<{ pointerId: number; targetId: string | null; edge: 'before' | 'after' | null } | null>(null);
  const autoScrollRef = useRef<{ raf: number | null; dir: number }>({ raf: null, dir: 0 });

  // Coarse pointers (touch): a tap SELECTS the row only — opening a full modal on
  // every row tap is wrong on mobile. The inspector opens via the now-visible ✎
  // glyph (or the `o` key). Fine pointers (desktop) keep click = select + open.
  const coarsePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  // Stop any auto-scroll loop if the row unmounts mid-drag.
  useEffect(() => () => stopAutoScroll(), []);

  function onDragOver(e: React.DragEvent): void {
    if (!id) return;
    const types = e.dataTransfer?.types;
    if (!types) return;
    // An in-app reorder drag: show a top/bottom insertion line based on which
    // half of the row the pointer is over.
    if (onReorder && types.includes(REORDER_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const edge = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      if (edge !== dropEdge) setDropEdge(edge);
      return;
    }
    // Otherwise only an attach-worthy drag (files or a URI list) gets the ring.
    if (!types.includes('Files') && !types.includes('text/uri-list')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  }

  function onDrop(e: React.DragEvent): void {
    if (!id) return;
    const types = e.dataTransfer?.types;
    // Reorder drop: move the dragged block before/after this row's task.
    if (onReorder && types && types.includes(REORDER_MIME)) {
      e.preventDefault();
      const sourceId = e.dataTransfer.getData(REORDER_MIME);
      // Compute the edge from the DROP geometry (synchronous) rather than the
      // dropEdge STATE — a fast drag can fire drop before the dragover render
      // commits, which would otherwise fall back to the wrong edge. dropEdge is
      // purely the visual insertion line.
      const rect = e.currentTarget.getBoundingClientRect();
      const place: 'before' | 'after' =
        e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      setDropEdge(null);
      if (sourceId && sourceId !== id) onReorder(sourceId, id, place);
      return;
    }
    const found = attachmentsFromTransfer(e.dataTransfer);
    if (found.length === 0) {
      setDropping(false);
      return;
    }
    e.preventDefault();
    setDropping(false);
    for (const a of found) addAttachment(id, a.label, a.target);
  }

  function onPaste(e: React.ClipboardEvent): void {
    if (!id) return;
    const found = attachmentsFromTransfer(e.clipboardData);
    if (found.length === 0) return; // not a URL/file paste — leave it alone
    e.preventDefault();
    for (const a of found) addAttachment(id, a.label, a.target);
  }

  // --- Long-press -> touch select mode ------------------------------------
  function cancelLongPress(): void {
    if (lpTimer.current !== null) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
    lpStart.current = null;
  }
  function onTouchStart(e: React.TouchEvent): void {
    if (!id || !coarsePointer) return;
    const t = e.touches[0];
    lpStart.current = { x: t.clientX, y: t.clientY };
    lpTimer.current = window.setTimeout(() => {
      lpTimer.current = null;
      // Swallow the click the finger-lift generates so it doesn't also toggle.
      suppressClick.current = true;
      enterSelectMode(id);
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(10); // light haptic where supported (Android)
      }
    }, LONG_PRESS_MS);
  }
  function onTouchMove(e: React.TouchEvent): void {
    if (lpStart.current === null) return;
    const t = e.touches[0];
    if (
      Math.abs(t.clientX - lpStart.current.x) > LP_MOVE_TOL ||
      Math.abs(t.clientY - lpStart.current.y) > LP_MOVE_TOL
    ) {
      cancelLongPress(); // a scroll/drag, not a press
    }
  }

  // --- Pointer-events drag-to-reorder (touch grip) ------------------------
  function clearDropLines(): void {
    document
      .querySelectorAll('.rune-row.is-tdrop-before, .rune-row.is-tdrop-after')
      .forEach((el) => el.classList.remove('is-tdrop-before', 'is-tdrop-after'));
  }
  function stopAutoScroll(): void {
    const a = autoScrollRef.current;
    if (a.raf !== null) {
      cancelAnimationFrame(a.raf);
      a.raf = null;
    }
    a.dir = 0;
  }
  function updateAutoScroll(clientY: number): void {
    const EDGE = 72;
    const dir = clientY < EDGE ? -1 : clientY > window.innerHeight - EDGE ? 1 : 0;
    const a = autoScrollRef.current;
    a.dir = dir;
    if (dir === 0) {
      stopAutoScroll();
      return;
    }
    if (a.raf !== null) return; // loop already running
    const step = (): void => {
      if (autoScrollRef.current.dir === 0) {
        autoScrollRef.current.raf = null;
        return;
      }
      window.scrollBy(0, autoScrollRef.current.dir * 9);
      autoScrollRef.current.raf = requestAnimationFrame(step);
    };
    a.raf = requestAnimationFrame(step);
  }
  function onGripPointerDown(e: React.PointerEvent): void {
    if (!id || !onReorder || e.pointerType === 'mouse') return; // mouse uses the HTML5 grip
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, targetId: null, edge: null };
    (e.currentTarget as HTMLElement).closest('.rune-row')?.classList.add('is-dragging');
  }
  function onGripPointerMove(e: React.PointerEvent): void {
    const st = dragRef.current;
    if (!st || e.pointerId !== st.pointerId) return;
    e.preventDefault();
    clearDropLines();
    st.targetId = null;
    st.edge = null;
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const row = (under?.closest('.rune-row[data-id]') as HTMLElement | null) ?? null;
    const tid = row?.dataset.id;
    if (row && tid && tid !== id) {
      const rect = row.getBoundingClientRect();
      const edge: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      row.classList.add(edge === 'before' ? 'is-tdrop-before' : 'is-tdrop-after');
      st.targetId = tid;
      st.edge = edge;
    }
    updateAutoScroll(e.clientY);
  }
  function endGripDrag(e: React.PointerEvent, commit: boolean): void {
    const st = dragRef.current;
    if (!st || e.pointerId !== st.pointerId) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(st.pointerId);
    } catch {
      // capture may already be gone — ignore
    }
    clearDropLines();
    stopAutoScroll();
    document.querySelectorAll('.rune-row.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    dragRef.current = null;
    if (commit && id && onReorder && st.targetId && st.edge && st.targetId !== id) {
      onReorder(id, st.targetId, st.edge);
    }
  }

  if (editing && id) {
    return (
      <RowEditor
        task={task}
        onCommit={(body) => onEditCommit?.(id, body)}
        onCancel={() => onEditCancel?.()}
      />
    );
  }

  return (
    <div
      className={clsx('rune-row', `state-${task.state}`, {
        'is-selected': selected,
        'is-struck': struck,
        'is-dropping': dropping,
        'is-drop-before': dropEdge === 'before',
        'is-drop-after': dropEdge === 'after',
      })}
      style={{ paddingLeft: `calc(${task.depth} * var(--space-6))` }}
      data-id={id ?? undefined}
      role="listitem"
      // aria-selected is invalid on role="listitem"; use aria-current for the
      // single selected row and aria-level to expose sub-task depth.
      aria-current={selected ? 'true' : undefined}
      aria-level={task.depth + 1}
      onMouseDown={(e) => {
        // Shift-click extends the range and ctrl/cmd-click toggles a row —
        // suppress the browser's native modifier-click TEXT selection so rows
        // tint instead of selecting text.
        if ((e.shiftKey && onSelectRange) || e.metaKey || e.ctrlKey) e.preventDefault();
      }}
      onClick={(e) => {
        if (!id) return;
        // A long-press just entered select mode — swallow the click the
        // finger-lift generates so it doesn't immediately toggle the row.
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        // Shift-click: extend the multi-selection from the anchor to this row
        // (never opens the inspector).
        if (e.shiftKey && onSelectRange) {
          onSelectRange(id);
          return;
        }
        // Ctrl/Cmd-click toggles this row in/out of the multi-selection
        // (additive) and never opens the inspector.
        if (e.metaKey || e.ctrlKey) {
          toggleSelect(id);
          return;
        }
        // In touch select mode a tap toggles the row (never opens the
        // inspector); long-press entered the mode.
        if (selectMode) {
          toggleSelect(id);
          return;
        }
        // A normal click selects AND opens the inspector for this item. The
        // checkbox / delete control stop propagation, so neither fires this; the
        // inline-edit input is a different render branch (this never runs there).
        onSelect(id);
        // On a coarse pointer (touch) a tap only selects — never auto-opens the
        // full-screen inspector sheet. The ✎ glyph (persistent on touch) opens it.
        if (coarsePointer) return;
        // But if the user just drag-selected text in the row, don't pop the
        // inspector over their selection — only select the row. (The ✎ control
        // always opens.)
        const sel = typeof window !== 'undefined' ? window.getSelection() : null;
        if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
        onOpen?.(id);
      }}
      onDoubleClick={() => id && (onEdit ? onEdit(id) : onOpen?.(id))}
      onDragOver={onDragOver}
      onDragLeave={() => {
        if (dropping) setDropping(false);
        if (dropEdge) setDropEdge(null);
      }}
      onDrop={onDrop}
      onPaste={onPaste}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={cancelLongPress}
      onTouchCancel={cancelLongPress}
    >
      <Checkbox state={task.state} onToggle={() => id && onToggle(id)} />
      <span className="rune-row-title">
        <span className="rune-row-text">{title}</span>
        {/* Fold the task state into the row's accessible name so screen readers
            announce "<title>, done" etc., not just the bare title. */}
        <span className="rune-visually-hidden">, {STATE_LABEL[task.state]}</span>
        {task.state === 'done' && <span className="rune-strike" aria-hidden="true" />}
      </span>
      <Meta task={task} now={now} />
      {dropping && <span className="rune-row-drop" aria-hidden="true">attach</span>}
      {/* Drag grip to reorder. HTML5 drag-and-drop needs a fine pointer (touch
          never fires dragstart), so it is desktop-only; keyboard reorder
          (Cmd/Ctrl+Up/Down) stays the accessible path. */}
      {id && onReorder && !coarsePointer && (
        <button
          type="button"
          className="rune-row-drag"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          draggable
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData(REORDER_MIME, id);
            e.dataTransfer.effectAllowed = 'move';
            const row = (e.currentTarget as HTMLElement).closest('.rune-row');
            if (row) e.dataTransfer.setDragImage(row as HTMLElement, 12, 12);
          }}
        >
          ⠿
        </button>
      )}
      {/* Touch reorder grip: persistent on coarse pointers, driven by Pointer
          Events (HTML5 DnD never fires on touch). Its touchstart is stopped so
          the row's long-press select mode doesn't also arm. */}
      {id && onReorder && coarsePointer && (
        <button
          type="button"
          className="rune-row-drag-touch"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={(e) => endGripDrag(e, true)}
          onPointerCancel={(e) => endGripDrag(e, false)}
        >
          ⠿
        </button>
      )}
      {/* Touch-only inline-edit trigger. On a fine pointer inline edit opens via
          double-click / the `e` key; a coarse pointer has neither, so the fast
          token-aware row editor would be unreachable. This persistent ✏ (shown
          only on coarse pointers, styled like the other row-chrome glyphs) is
          its touch entry point; desktop is unchanged (it stays hidden there). */}
      {id && onEdit && coarsePointer && (
        <button
          type="button"
          className="rune-row-edit"
          aria-label="Edit inline"
          title="Edit inline"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(id);
            onEdit(id);
          }}
        >
          ✏
        </button>
      )}
      {id && onOpen && (
        <button
          type="button"
          className="rune-row-inspect"
          aria-label="Open inspector"
          title="Open inspector"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(id);
            onOpen(id);
          }}
        >
          ✎
        </button>
      )}
      {id && onDelete && (
        <button
          type="button"
          className="rune-row-delete"
          aria-label="Delete task"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(id);
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** The inline-edit surface: a single text input with a live preview line. */
function RowEditor({
  task,
  onCommit,
  onCancel,
}: {
  task: TaskNode;
  onCommit: (body: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(() => editableBody(task));
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const preview = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return previewLine(parseInput(trimmed));
  }, [value]);

  function commit(): void {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value.trim());
  }

  return (
    <div
      className="rune-row is-editing"
      style={{ paddingLeft: `calc(${task.depth} * var(--space-6))` }}
    >
      <Checkbox state={task.state} onToggle={() => {}} />
      <span className="rune-row-edit-wrap">
        <input
          ref={inputRef}
          className="rune-row-edit-input"
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              committedRef.current = true; // suppress the blur commit
              onCancel();
            }
          }}
        />
        {preview && <span className="rune-row-edit-preview">{preview}</span>}
      </span>
    </div>
  );
}
