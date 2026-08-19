// SequenceView — the dependency-ordered view (BRIEF §5).
//
// Renders the real sequence() resolution as three calm bands:
//   Ready   — open/doing tasks whose deps are all done; what you can do NOW.
//   Blocked — dimmed, each with a quiet 13px "waiting on …" line naming the
//             unfinished predecessors by title.
//   Done    — faint, last.
//
// Selection/toggle/onOpen wiring and class names mirror DocumentView exactly;
// all mutations go through the store. Single column, tokens only, no clutter.

import { useStore } from '../store/store';
import { sequence } from '../lib/sequence';
import { Row } from '../components/Row';
import type { TaskNode } from '@core';
import { titleOf } from '@core';

export interface SequenceViewProps {
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

export function SequenceView({
  now,
  onOpen,
  editingId,
  onEdit,
  onDelete,
  onEditCommit,
  onEditCancel,
  onSelectRange,
}: SequenceViewProps): JSX.Element {
  const doc = useStore((s) => s.doc);
  const selectedIds = useStore((s) => s.selectedIds);
  const select = useStore((s) => s.select);
  const toggle = useStore((s) => s.toggle);

  const { ready, blocked, done } = sequence(doc);

  const hasAny = ready.length > 0 || blocked.length > 0 || done.length > 0;
  if (!hasAny) {
    return (
      <div className="rune-empty">
        <p className="rune-empty-line">Nothing to sequence.</p>
        <p className="rune-empty-hint">Add tasks and link them with <kbd>after:</kbd></p>
      </div>
    );
  }

  const renderRow = (task: TaskNode, i: number, prefix: string): JSX.Element => (
    <Row
      key={task.id ?? `${prefix}-${i}`}
      task={task}
      selected={!!task.id && selectedIds.includes(task.id)}
      now={now}
      onSelect={select}
      onSelectRange={onSelectRange}
      onToggle={toggle}
      onOpen={onOpen}
      onEdit={onEdit}
      onDelete={onDelete}
      editing={!!task.id && task.id === editingId}
      onEditCommit={onEditCommit}
      onEditCancel={onEditCancel}
    />
  );

  return (
    <div className="rune-doc" role="list">
      {ready.length > 0 && (
        <>
          <h2 className="rune-section">Ready</h2>
          {ready.map((t, i) => renderRow(t, i, 'ready'))}
        </>
      )}

      {blocked.length > 0 && (
        <>
          <h2 className="rune-section">Blocked</h2>
          {blocked.map(({ task, waitingOn }, i) => (
            <div key={task.id ?? `blocked-${i}`} className="is-blocked">
              {renderRow(task, i, 'blocked')}
              <p className="rune-waiting">waiting on: {waitingOn.map(titleOf).join(', ')}</p>
            </div>
          ))}
        </>
      )}

      {done.length > 0 && (
        <>
          <h2 className="rune-section">Done</h2>
          {done.map((t, i) => renderRow(t, i, 'done'))}
        </>
      )}
    </div>
  );
}
