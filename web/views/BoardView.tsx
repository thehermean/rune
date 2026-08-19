// BoardView — the kanban lens (owner-authorised feature).
//
// A VIEW over the same parsed todo doc (like Today/Sequence): the `#board` cards
// laid out in five fixed columns keyed by their `col:<slug>` token. No second
// store, no second copy of the doc. The column set + col:→state contract lives in
// lib/board.ts; moving a card routes through store.moveToColumn, which sets both
// the col: token and the mirrored state in ONE commit down the normal sync path.
//
// Drag is hand-rolled on Pointer Events (house style — no dep). A card's GRIP is
// the drag handle (touch-action:none) so the column body still scrolls under a
// touch on the card itself; the card body taps open the inspector. A pointer that
// crosses into another column drops the card there; a non-crossing release is a
// no-op (and a tap on the body opens it).

import { useRef, useState } from 'react';
import { contextsOf, getKey, priorityOf, titleOf } from '@core';
import type { TaskNode } from '@core';
import { useStore } from '../store/store';
import { COLUMNS, boardColumns, columnOf, nextNoteOf, type ColKey } from '../lib/board';
import { formatShort, isOverdue } from '../lib/dates';

export interface BoardViewProps {
  /** Open the card in the detail inspector (edit its notes/fields). */
  onOpen?: (id: string) => void;
  now?: Date;
}

/** A live drag in progress: which card, its source column, the current pointer
 *  position (for the floating clone), and the column currently under the pointer. */
interface DragState {
  id: string;
  from: ColKey;
  title: string;
  x: number;
  y: number;
  over: ColKey | null;
}

/** Movement (px) before a grip press becomes a drag rather than a stray tap. */
const DRAG_THRESHOLD = 5;

export function BoardView({ onOpen, now = new Date() }: BoardViewProps): JSX.Element {
  const doc = useStore((s) => s.doc);
  const moveToColumn = useStore((s) => s.moveToColumn);

  const cols = boardColumns(doc);
  const total = COLUMNS.reduce((n, c) => n + cols[c.key].length, 0);

  // Live drag state (re-renders the highlight + floating clone). The candidate
  // press is held in a ref until it crosses the threshold, so a plain tap on the
  // grip never triggers a render or a move.
  const [drag, setDrag] = useState<DragState | null>(null);
  const pressRef = useRef<
    | { id: string; from: ColKey; title: string; startX: number; startY: number; active: boolean }
    | null
  >(null);

  /** The column under a client point (via elementFromPoint → nearest [data-col]). */
  function columnAtPoint(x: number, y: number): ColKey | null {
    const el = document.elementFromPoint(x, y);
    const colEl = el?.closest('[data-col]') as HTMLElement | null;
    const key = colEl?.dataset.col;
    return key && COLUMNS.some((c) => c.key === key) ? (key as ColKey) : null;
  }

  function onGripDown(e: React.PointerEvent, card: TaskNode, from: ColKey): void {
    if (!card.id) return;
    // Left button / touch / pen only; ignore secondary buttons.
    if (e.button !== 0) return;
    pressRef.current = {
      id: card.id,
      from,
      title: titleOf(card) || 'Untitled',
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onGripMove(e: React.PointerEvent): void {
    const p = pressRef.current;
    if (!p) return;
    if (!p.active) {
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < DRAG_THRESHOLD) return;
      p.active = true; // crossed the threshold — the drag is real now
    }
    e.preventDefault();
    setDrag({
      id: p.id,
      from: p.from,
      title: p.title,
      x: e.clientX,
      y: e.clientY,
      over: columnAtPoint(e.clientX, e.clientY),
    });
  }

  function onGripUp(e: React.PointerEvent): void {
    const p = pressRef.current;
    pressRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (p?.active) {
      const over = columnAtPoint(e.clientX, e.clientY);
      if (over && over !== p.from) moveToColumn(p.id, over);
    }
    setDrag(null);
  }

  if (total === 0) {
    return (
      <div className="rune-empty">
        <p className="rune-empty-line">No board cards yet.</p>
        <p className="rune-empty-hint">
          Tag a task <kbd>#board</kbd> to place it on the board.
        </p>
      </div>
    );
  }

  return (
    <div className="rune-board" role="list" aria-label="Board">
      {COLUMNS.map((col) => {
        const cards = cols[col.key];
        const isDropTarget = drag !== null && drag.over === col.key && drag.from !== col.key;
        return (
          <section
            key={col.key}
            className={`rune-board-col${isDropTarget ? ' is-drop' : ''}`}
            data-col={col.key}
            role="listitem"
            aria-label={`${col.label}, ${cards.length} card${cards.length === 1 ? '' : 's'}`}
          >
            <header className="rune-board-colhead">
              <span className="rune-board-collabel">{col.label}</span>
              {cards.length > 0 && <span className="rune-board-colcount">{cards.length}</span>}
            </header>
            <div className="rune-board-colbody">
              {cards.map((card) => (
                <Card
                  key={card.id ?? titleOf(card)}
                  card={card}
                  col={col.key}
                  now={now}
                  dragging={drag?.id === card.id}
                  next={card.id ? nextNoteOf(doc, card.id) : ''}
                  onOpen={onOpen}
                  onGripDown={onGripDown}
                  onGripMove={onGripMove}
                  onGripUp={onGripUp}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* The floating clone that follows the pointer during a drag. pointer-events
          are off so elementFromPoint sees the column beneath it, not the clone. */}
      {drag && (
        <div
          className="rune-board-ghost"
          style={{ left: drag.x, top: drag.y }}
          aria-hidden="true"
        >
          {drag.title}
        </div>
      )}
    </div>
  );
}

function Card({
  card,
  col,
  now,
  dragging,
  next,
  onOpen,
  onGripDown,
  onGripMove,
  onGripUp,
}: {
  card: TaskNode;
  col: ColKey;
  now: Date;
  dragging: boolean;
  next: string;
  onOpen?: (id: string) => void;
  onGripDown: (e: React.PointerEvent, card: TaskNode, from: ColKey) => void;
  onGripMove: (e: React.PointerEvent) => void;
  onGripUp: (e: React.PointerEvent) => void;
}): JSX.Element {
  const owners = contextsOf(card);
  const prio = priorityOf(card);
  const due = getKey(card, 'due');
  const title = titleOf(card) || 'Untitled';

  return (
    <article className={`rune-board-card${dragging ? ' is-dragging' : ''}`} data-id={card.id ?? ''}>
      <button
        type="button"
        className="rune-board-grip"
        aria-label="Drag card to another column"
        title="Drag to move"
        onPointerDown={(e) => onGripDown(e, card, col)}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      >
        ⋮⋮
      </button>
      <div
        className="rune-board-cardbody"
        role="button"
        tabIndex={0}
        onClick={() => card.id && onOpen?.(card.id)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && card.id) {
            e.preventDefault();
            onOpen?.(card.id);
          }
        }}
      >
        <div className="rune-board-cardtitle">{title}</div>
        {(owners.length > 0 || prio > 0 || due) && (
          <div className="rune-meta rune-board-cardmeta">
            {owners.map((o) => (
              <span key={`o-${o}`} className="rune-meta-ctx">
                @{o}
              </span>
            ))}
            {prio > 0 && <span className="rune-meta-prio">{'!'.repeat(prio)}</span>}
            {due && (
              <span className={`rune-meta-date${isOverdue(due, now) ? ' is-overdue' : ''}`}>
                {formatShort(due, now)}
              </span>
            )}
          </div>
        )}
        {next && (
          <div className="rune-board-cardnext">
            <span className="rune-board-nextlabel">Next</span> {next}
          </div>
        )}
      </div>
    </article>
  );
}
