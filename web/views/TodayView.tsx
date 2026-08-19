// TodayView — the agenda (BRIEF §5).
//
// Today is a DERIVED FILTER, not a place tasks live: open tasks whose due: or
// scheduled: is on or before now (overdue included), pre-sorted priority desc
// then date asc. The filter is owned by lib/today.ts (todayItems) — we call it
// and never duplicate it. Presentation only: a single calm column of Rows.
//
// Overdue tinting lives in Meta/Row (the date goes --danger), so we just pass
// `now` through. Selection + toggle + open wire to the store exactly as
// DocumentView does. This view owns selection rendering only; mutations go
// through the store.

import { useStore } from '../store/store';
import { todayItems } from '../lib/today';
import { Row } from '../components/Row';
import { toISO } from '../lib/dates';

export interface TodayViewProps {
  now?: Date;
  onOpen?: (id: string) => void;
  editingId?: string | null;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onEditCommit?: (id: string, body: string) => void;
  onEditCancel?: () => void;
  /** Shift-click range extension over the rendered rows (wired by App). */
  onSelectRange?: (id: string) => void;
}

export function TodayView({
  now = new Date(),
  onOpen,
  editingId,
  onEdit,
  onDelete,
  onEditCommit,
  onEditCancel,
  onSelectRange,
}: TodayViewProps): JSX.Element {
  const doc = useStore((s) => s.doc);
  const selectedIds = useStore((s) => s.selectedIds);
  const select = useStore((s) => s.select);
  const toggle = useStore((s) => s.toggle);

  const items = todayItems(doc, toISO(now));

  if (items.length === 0) {
    return (
      <div className="rune-empty">
        <p className="rune-empty-line">Nothing due.</p>
        <p className="rune-empty-hint">
          Press <kbd>c</kbd> to add.
        </p>
      </div>
    );
  }

  return (
    <div className="rune-doc" role="list">
      {items.map((t, i) => (
        <Row
          key={t.id ?? `today-${i}`}
          task={t}
          selected={!!t.id && selectedIds.includes(t.id)}
          now={now}
          onSelect={select}
          onSelectRange={onSelectRange}
          onToggle={toggle}
          onOpen={onOpen}
          onEdit={onEdit}
          onDelete={onDelete}
          editing={!!t.id && t.id === editingId}
          onEditCommit={onEditCommit}
          onEditCancel={onEditCancel}
        />
      ))}
    </div>
  );
}
