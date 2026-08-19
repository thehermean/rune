// DocumentView — the default view (BRIEF §5).
//
// Renders the parsed Doc top-to-bottom in FILE ORDER; hierarchy by depth. Each
// task is a Row (Checkbox + title + inline Meta). Notes (`> ` lines) render at
// 13px mute under their parent. Headings render as section headers. The header
// html-comment is HIDDEN. Blank lines collapse to small vertical rhythm.
//
// Filter: a slim hairline input revealed by `/` (App owns the key; `filterOpen`
// arrives as a prop). The query IS the capture grammar (lib/filter): `#finance`
// narrows by tag, `@home` by context, `!!!` by priority ≥ 3, bare words
// substring-match titles, `overdue` / `due:today` by date. Matching tasks show
// with their ANCESTOR chain so hierarchy stays legible; non-matching rows are
// absent, not dimmed. Esc clears + collapses; blurring an EMPTY input collapses
// too. The filter deliberately RESETS when it collapses — a hidden filter that
// keeps narrowing the list would be invisible state (anxiety chrome).
//
// Priority sort: when the query targets priority (!/!!/!!!), matches render as a
// FLAT list ordered by priority (high→low, ties by file order) instead of file
// order. Reordering makes hierarchy meaningless, so ancestors/indent are dropped
// in that mode; the .rune file is never reordered.
//
// This view owns selection rendering only; mutations go through the store.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Node, TaskNode } from '@core';
import { priorityOf } from '@core';
import { Row } from '../components/Row';
import { descendantEndIndex } from '../lib/edit';
import { compileFilter, matchesFilter } from '../lib/filter';
import { useStore } from '../store/store';

export interface DocumentViewProps {
  now?: Date;
  onOpen?: (id: string) => void;
  /** The row currently in inline-edit mode (owned by App). */
  editingId?: string | null;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onEditCommit?: (id: string, body: string) => void;
  onEditCancel?: () => void;
  /** Shift-click range extension (App wires it to store.selectRange over the
   *  rendered rows). */
  onSelectRange?: (id: string) => void;
  /** True while the `/` filter input is revealed (owned by App; the key lives
   *  in the global handler). */
  filterOpen?: boolean;
  /** Collapse the filter (empty blur / Esc). The query resets on collapse. */
  onFilterCollapse?: () => void;
}

export function DocumentView({
  now,
  onOpen,
  editingId,
  onEdit,
  onDelete,
  onEditCommit,
  onEditCancel,
  onSelectRange,
  filterOpen = false,
  onFilterCollapse,
}: DocumentViewProps): JSX.Element {
  const doc = useStore((s) => s.doc);
  const selectedIds = useStore((s) => s.selectedIds);
  const select = useStore((s) => s.select);
  const toggle = useStore((s) => s.toggle);
  const hideDone = useStore((s) => s.hideDone);
  const moveTo = useStore((s) => s.moveTo);

  // The filter query lives HERE and resets whenever the input collapses (the
  // documented persistence decision: a collapsed filter never keeps narrowing).
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  // Reveal -> focus; collapse -> reset the query.
  useEffect(() => {
    if (filterOpen) {
      const id = requestAnimationFrame(() => filterRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    setQuery('');
    return undefined;
  }, [filterOpen]);

  const filter = useMemo(() => compileFilter(query, now), [query, now]);
  const filtering = filterOpen && !filter.isEmpty;
  // When the query targets priority (!, !!, !!!), matches render as a flat list
  // ordered by priority (high→low) rather than file order.
  const prioritySort = filtering && filter.minPriority > 0;
  // Drag-reorder only in the plain file-order list — a filtered or priority-
  // sorted view is derived, so reordering it has no canonical meaning.
  const reorderEnabled = !filtering;

  const hasTasks = doc.nodes.some((n) => n.type === 'task');

  // "Hide done": drop each done task AND its descendant block (sub-items, notes,
  // comments), so nothing is left orphaned.
  const hidden = new Set<number>();
  if (hideDone) {
    for (let i = 0; i < doc.nodes.length; i++) {
      const n = doc.nodes[i];
      if (n.type === 'task' && n.state === 'done') {
        const end = descendantEndIndex(doc, i);
        for (let j = i; j < end; j++) hidden.add(j);
        i = end - 1;
      }
    }
  }

  // Filter pass: keep matching tasks plus their ANCESTOR chain (tasks at lower
  // indent preceding them), so the hierarchy stays legible. Everything else
  // (non-matching tasks, headings, notes, blanks) is absent while filtering.
  let visible: Set<number> | null = null;
  // In priority-sort mode this holds matching task indices in priority order and
  // drives the render instead of file order.
  let sortedOrder: number[] | null = null;
  if (prioritySort) {
    const matches: number[] = [];
    for (let i = 0; i < doc.nodes.length; i++) {
      const n = doc.nodes[i];
      if (n.type !== 'task' || hidden.has(i)) continue;
      if (matchesFilter(n, filter, now)) matches.push(i);
    }
    // Highest priority first; equal priorities keep their original file order.
    matches.sort((a, b) => {
      const pa = priorityOf(doc.nodes[a] as TaskNode);
      const pb = priorityOf(doc.nodes[b] as TaskNode);
      return pb - pa || a - b;
    });
    sortedOrder = matches;
    visible = new Set(matches);
  } else if (filtering) {
    visible = new Set<number>();
    // ancestors[k] = index of the nearest preceding task at indent-depth k.
    const ancestors: number[] = [];
    for (let i = 0; i < doc.nodes.length; i++) {
      const n = doc.nodes[i];
      if (n.type !== 'task') continue;
      const depth = Math.floor(n.indent / 2);
      ancestors.length = depth; // drop deeper/equal ancestors
      ancestors[depth] = i;
      if (hidden.has(i)) continue;
      if (matchesFilter(n, filter, now)) {
        for (const a of ancestors) if (a !== undefined && !hidden.has(a)) visible.add(a);
      }
    }
  }

  const rowVisible = (i: number): boolean => {
    if (hidden.has(i)) return false;
    return visible ? visible.has(i) : true;
  };

  const anyVisibleTask = doc.nodes.some((n, i) => n.type === 'task' && rowVisible(i));

  const filterBar = filterOpen ? (
    <div className="rune-filter">
      <input
        ref={filterRef}
        className="rune-filter-input"
        type="text"
        value={query}
        placeholder="Filter…  #tag  @context  !!!  overdue  words"
        spellCheck={false}
        autoComplete="off"
        aria-label="Filter tasks"
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => {
          // An empty input collapses to nothing on blur; a non-empty one stays
          // so the narrowed list remains legible while you work it.
          if (!query.trim()) onFilterCollapse?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onFilterCollapse?.(); // clears (via the collapse effect) + collapses
          } else if (e.key === 'Enter') {
            e.preventDefault();
            filterRef.current?.blur(); // keep the filter, return to the list keys
          }
        }}
      />
    </div>
  ) : null;

  if (!hasTasks) {
    return (
      <>
        {filterBar}
        <div className="rune-empty">
          <p className="rune-empty-line">Nothing here yet.</p>
          <p className="rune-empty-hint">
            Press <kbd>c</kbd> to add a task
          </p>
        </div>
      </>
    );
  }

  if (!anyVisibleTask && filtering) {
    return (
      <>
        {filterBar}
        <div className="rune-empty">
          <p className="rune-empty-line">Nothing matches.</p>
          <p className="rune-empty-hint">
            <kbd>Esc</kbd> clears the filter
          </p>
        </div>
      </>
    );
  }

  if (hideDone && !anyVisibleTask) {
    return (
      <>
        {filterBar}
        <div className="rune-empty">
          <p className="rune-empty-line">All done — nothing active.</p>
          <p className="rune-empty-hint">Click “Show done” to see completed tasks.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {filterBar}
      <div className="rune-doc" role="list">
        {prioritySort
          ? sortedOrder!.map((i) => {
              // Reordered by priority, so hierarchy no longer applies — render
              // each match flat (depth 0) rather than at its original indent.
              const node = { ...(doc.nodes[i] as TaskNode), depth: 0 };
              return renderNode(node, i);
            })
          : doc.nodes.map((node, i) => {
              if (!rowVisible(i)) return null;
              // While filtering, only task rows render (headings/notes/blanks
              // would read as orphaned fragments between non-adjacent matches).
              if (filtering && node.type !== 'task') return null;
              return renderNode(node, i);
            })}
      </div>
    </>
  );

  function renderNode(node: Node, i: number): JSX.Element | null {
    switch (node.type) {
      case 'task':
        return (
          <Row
            key={node.id ?? `task-${i}`}
            task={node}
            selected={!!node.id && selectedIds.includes(node.id)}
            now={now}
            onSelect={select}
            onSelectRange={onSelectRange}
            onToggle={toggle}
            onOpen={onOpen}
            onEdit={onEdit}
            onDelete={onDelete}
            editing={!!node.id && node.id === editingId}
            onEditCommit={onEditCommit}
            onEditCancel={onEditCancel}
            onReorder={reorderEnabled ? moveTo : undefined}
          />
        );
      case 'heading':
        return (
          <h2 key={`h-${i}`} className="rune-section">
            {stripHeading(node.raw)}
          </h2>
        );
      case 'note':
        return (
          <p key={`note-${i}`} className="rune-note" style={indentStyle(node.indent)}>
            {stripNote(node.raw)}
          </p>
        );
      case 'comment':
        // Standalone CriticMarkup lines belong to the gutter (Wave 2); keep them
        // out of the reading flow for MVP.
        return null;
      case 'html-comment':
        // The self-briefing header comment is hidden from the rendered view.
        return null;
      case 'blank':
        return <div key={`blank-${i}`} className="rune-blank" aria-hidden="true" />;
      case 'text':
        return (
          <p key={`text-${i}`} className="rune-rawtext">
            {node.raw}
          </p>
        );
      default:
        return null;
    }
  }
}

function indentStyle(indent: number | undefined): React.CSSProperties {
  const depth = Math.floor((indent ?? 0) / 2);
  return { paddingLeft: `calc(${depth} * var(--space-6))` };
}

function stripHeading(raw: string): string {
  return raw.replace(/^#{1,6}\s+/, '').trim();
}

function stripNote(raw: string): string {
  return raw.replace(/^\s*>\s?/, '');
}
