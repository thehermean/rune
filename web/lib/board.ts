// The Board (kanban) contract — a LENS over the same parsed todo doc, shared by
// BoardView and the store's moveToColumn action so the column set, their labels,
// order, and the col:→state mapping live in exactly ONE place.
//
// Board cards are ordinary `.rune` tasks tagged `#board`. Their column is carried
// in an UNKNOWN `col:<slug>` key (preserved-but-ignored by the parser per RUNE.md),
// written/read by external agents via /api/doc — so this module only ever READS
// col: and, on a move, rewrites it through the normal store mutation path. A card
// we don't move round-trips its col: untouched like any other unknown key.

import type { Doc, State, TaskNode } from '@core';
import { getKey, tagsOf, tasks } from '@core';

/** The tag that marks a task as a board card. */
export const BOARD_TAG = 'board';

export type ColKey = 'backlog' | 'doing' | 'blocked' | 'input' | 'done';

/** The five columns, in fixed display order, each with its label and the task
 *  STATE that must mirror it (`backlog→open`, `doing→doing`, `blocked→deferred`,
 *  `input→deferred`, `done→done`). Moving a card sets BOTH its col: and state. */
export const COLUMNS: ReadonlyArray<{ key: ColKey; label: string; state: State }> = [
  { key: 'backlog', label: 'Backlog', state: 'open' },
  { key: 'doing', label: 'Doing', state: 'doing' },
  { key: 'blocked', label: 'Blocked', state: 'deferred' },
  { key: 'input', label: 'Needs Input', state: 'deferred' },
  { key: 'done', label: 'Done', state: 'done' },
];

const BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

/** True when a slug names a real column. */
export function isColKey(slug: string): slug is ColKey {
  return BY_KEY.has(slug as ColKey);
}

/** The state a card must carry when it lives in this column. */
export function stateForColumn(key: ColKey): State {
  return BY_KEY.get(key)?.state ?? 'open';
}

/** Is this task a board card? (carries the `#board` tag) */
export function isBoardTask(t: TaskNode): boolean {
  return tagsOf(t).includes(BOARD_TAG);
}

/** The column a card belongs to: its `col:` slug when it names a real column,
 *  else Backlog (a `#board` task with no/unknown col: falls to Backlog). */
export function columnOf(t: TaskNode): ColKey {
  const slug = (getKey(t, 'col') ?? '').toLowerCase();
  return isColKey(slug) ? slug : 'backlog';
}

/** Every `#board` card, in document order. */
export function boardTasks(doc: Doc): TaskNode[] {
  return tasks(doc).filter(isBoardTask);
}

/** Group the board cards into the five columns (fixed order), each in document
 *  order. Empty columns are still present (Blocked always renders). */
export function boardColumns(doc: Doc): Record<ColKey, TaskNode[]> {
  const out: Record<ColKey, TaskNode[]> = {
    backlog: [], doing: [], blocked: [], input: [], done: [],
  };
  for (const t of boardTasks(doc)) out[columnOf(t)].push(t);
  return out;
}

/** The child `> Next: …` note text for a card (the words after "Next:"), or ''.
 *  Reads the first `> Next:` note nested under the task (deeper indent), stopping
 *  at the next same-or-shallower task line. Presentation only — never mutated. */
export function nextNoteOf(doc: Doc, id: string): string {
  const nodes = doc.nodes;
  const i = nodes.findIndex((n) => n.type === 'task' && n.id === id);
  if (i === -1) return '';
  const parentIndent = (nodes[i] as TaskNode).indent;
  for (let j = i + 1; j < nodes.length; j++) {
    const n = nodes[j];
    if (n.type === 'task' && n.indent <= parentIndent) break;
    if (n.type === 'note' && (n.indent ?? 0) > parentIndent) {
      const m = n.raw.match(/>\s*Next:\s*(.*)$/i);
      if (m) return m[1].trim();
    }
  }
  return '';
}
