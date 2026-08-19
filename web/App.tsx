// App — the top bar, the view switcher, and the global keyboard handler.
//
// Three views and one palette (BRIEF §5). The QuickAdd bar is pinned at the top
// of every view. A single keydown handler implements the keyboard model. State
// is intentionally minimal: the active view, the detail-card target, and the
// palette open flag live here; everything about the document lives in the store.
//
// Wave 2 rule: agents NEVER edit this file or store.ts (see web/CONTRACTS.md).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tasks, titleOf } from '@core';
import type { State } from '@core';
import { useStore } from './store/store';
import { supportsDirectoryAccess } from './lib/persist';
import { todayItems } from './lib/today';
import { toISO } from './lib/dates';
import { isModalScopeActive, useModalScope } from './lib/modalScope';
import { QuickAdd, type QuickAddHandle } from './components/QuickAdd';
import { CommandPalette } from './components/CommandPalette';
import { DetailCard } from './components/DetailCard';
import { ShareDialog } from './components/ShareDialog';
import { SyncDialog } from './components/SyncDialog';
import { ReviewModal } from './components/ReviewModal';
import { HelpSheet } from './components/HelpSheet';
import { DocumentView } from './views/DocumentView';
import { SelectionBar } from './components/SelectionBar';
import { NotesView } from './views/NotesView';
import { TodayView } from './views/TodayView';
import { SequenceView } from './views/SequenceView';
import { SourceView } from './views/SourceView';
import { BoardView } from './views/BoardView';

type ViewName = 'document' | 'today' | 'sequence' | 'source' | 'notes' | 'board';

export function App(): JSX.Element {
  const init = useStore((s) => s.init);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const hideDone = useStore((s) => s.hideDone);
  const setHideDone = useStore((s) => s.setHideDone);
  const fileName = useStore((s) => s.fileName);
  const openFile = useStore((s) => s.openFile);
  const openFolder = useStore((s) => s.openFolder);
  const save = useStore((s) => s.save);

  const doc = useStore((s) => s.doc);
  const selectedId = useStore((s) => s.selectedId);
  const selectedIds = useStore((s) => s.selectedIds);
  const select = useStore((s) => s.select);
  const selectRange = useStore((s) => s.selectRange);
  const toggle = useStore((s) => s.toggle);
  const toggleManyDone = useStore((s) => s.toggleManyDone);
  const indent = useStore((s) => s.indent);
  const outdent = useStore((s) => s.outdent);
  const indentMany = useStore((s) => s.indentMany);
  const outdentMany = useStore((s) => s.outdentMany);
  const move = useStore((s) => s.move);
  const removeTaskWithTicket = useStore((s) => s.removeTaskWithTicket);
  const restoreDeleted = useStore((s) => s.restoreDeleted);
  const removeManyWithTicket = useStore((s) => s.removeManyWithTicket);
  const restoreDeletedMany = useStore((s) => s.restoreDeletedMany);
  const setBody = useStore((s) => s.setBody);
  const addChild = useStore((s) => s.addChild);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const syncStatus = useStore((s) => s.syncStatus);
  const syncError = useStore((s) => s.syncError);
  const syncConflict = useStore((s) => s.syncConflict);
  const saveError = useStore((s) => s.saveError);
  const ackSaveError = useStore((s) => s.ackSaveError);
  const fileReconnectNeeded = useStore((s) => s.fileReconnectNeeded);
  const reconnectFile = useStore((s) => s.reconnectFile);

  const [view, setView] = useState<ViewName>('document');
  // The `/` filter on the Document view. App owns only the OPEN flag (the key is
  // global); the query itself lives in DocumentView and resets on collapse.
  const [filterOpen, setFilterOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const quickAddRef = useRef<QuickAddHandle>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSyncStatus = useRef(syncStatus);
  // Snapshot of the last-seen tasks (id -> state + title) so we can diff the doc
  // and announce single-item add/complete/delete to the aria-live region.
  const prevTasksRef = useRef<Map<string, { state: State; title: string }>>(new Map());

  // A quiet count of today's actionable items (due/scheduled ≤ today, overdue
  // included) for the Today tab. Derived straight off the doc so it updates live
  // with every edit; zero renders NOTHING (no "·0" — BRIEF: no anxiety chrome).
  const todayCount = useMemo(() => todayItems(doc, toISO(new Date())).length, [doc]);

  // A calm bottom toast. Most toasts are message-only (sync failed, save error,
  // conflict notice); only a genuinely undoable action passes an `undo` callback,
  // which renders the Undo button. This stops "Sync failed" from offering an Undo
  // that would revert the user's last legitimate edit.
  const showToast = useCallback((message: string, undo?: () => void) => {
    setToast({ message, undo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // Commit / cancel handlers for inline row editing.
  const onEditCommit = useCallback(
    (id: string, body: string) => {
      setBody(id, body);
      setEditingId(null);
    },
    [setBody],
  );
  const onEditCancel = useCallback(() => setEditingId(null), []);
  const onEdit = useCallback((id: string) => {
    setEditingId(id);
    select(id);
  }, [select]);
  const onDelete = useCallback(
    (id: string) => {
      // Scoped delete: capture a ticket so the toast's Undo restores THIS block
      // specifically, rather than calling global undo() (which reverts whatever
      // the most recent action happened to be — possibly not this delete).
      const ticket = removeTaskWithTicket(id);
      if (ticket) showToast('Task deleted', () => restoreDeleted(ticket));
    },
    [removeTaskWithTicket, restoreDeleted, showToast],
  );

  // Delete the current selection: one row via the single ticket path, a
  // multi-selection via ONE bulk ticket — one commit, one toast, one Undo that
  // restores every block.
  const deleteSelection = useCallback(() => {
    if (selectedIds.length > 1) {
      const bulk = removeManyWithTicket(selectedIds);
      if (bulk) {
        showToast(`${bulk.tickets.length} tasks deleted`, () => restoreDeletedMany(bulk));
      }
      return;
    }
    if (selectedId) onDelete(selectedId);
  }, [selectedIds, selectedId, removeManyWithTicket, restoreDeletedMany, onDelete, showToast]);

  // The ⋯ overflow popover is a modal scope too: while it's open the global
  // shortcuts must not act on the list behind it. Registering it here means the
  // global handler's single `isModalScopeActive()` guard covers it, replacing the
  // old ad-hoc overflowOpen/helpOpen special-cases.
  useModalScope(overflowOpen);

  // The overflow popover owns Esc (the global handler early-returns on any active
  // scope, so it can no longer close the menu for us).
  useEffect(() => {
    if (!overflowOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOverflowOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overflowOpen]);

  // Load the document once on mount and apply the persisted theme attribute.
  useEffect(() => {
    void init();
  }, [init]);

  // The `/` filter belongs to the Document view; leaving it collapses (and so
  // resets) the filter rather than carrying invisible narrowing state around.
  useEffect(() => {
    if (view !== 'document') setFilterOpen(false);
  }, [view]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const prevSyncConflict = useRef(syncConflict);

  // Surface a quiet toast when sync transitions into an error state.
  useEffect(() => {
    if (syncStatus === 'error' && prevSyncStatus.current !== 'error') {
      showToast(syncError ? `Sync failed: ${syncError}` : 'Sync failed');
    }
    prevSyncStatus.current = syncStatus;
  }, [syncStatus, syncError, showToast]);

  // A persistence failure (quota / blocked storage / failed file write) is a
  // one-shot message: toast it once, then acknowledge it in the store.
  useEffect(() => {
    if (saveError) {
      showToast(saveError);
      ackSaveError();
    }
  }, [saveError, showToast, ackSaveError]);

  // Surface a quiet toast the moment a sync conflict appears (the SyncDialog
  // carries the Reload / Keep-mine resolution).
  useEffect(() => {
    if (syncConflict && !prevSyncConflict.current) {
      showToast('This list changed on another device — open Sync to reload.');
    }
    prevSyncConflict.current = syncConflict;
  }, [syncConflict, showToast]);

  // Announce single-item add / complete / delete to the polite live region for
  // screen-reader users. We only announce clean SINGLE-item deltas so bulk moves
  // (initial load, undo/redo, sync adopt, clear-completed) don't spam the region.
  useEffect(() => {
    const cur = new Map<string, { state: State; title: string }>();
    for (const t of tasks(doc)) {
      if (t.id) cur.set(t.id, { state: t.state, title: titleOf(t) || 'Untitled' });
    }
    const prev = prevTasksRef.current;
    const added: string[] = [];
    const completed: string[] = [];
    for (const [id, v] of cur) {
      const before = prev.get(id);
      if (!before) added.push(v.title);
      else if (v.state === 'done' && before.state !== 'done') completed.push(v.title);
    }
    const removed: string[] = [];
    for (const [id, v] of prev) if (!cur.has(id)) removed.push(v.title);

    let msg = '';
    if (added.length === 1 && removed.length === 0) msg = `Added: ${added[0]}`;
    else if (removed.length === 1 && added.length === 0) msg = `Deleted: ${removed[0]}`;
    else if (completed.length === 1 && added.length === 0 && removed.length === 0) {
      msg = `Completed: ${completed[0]}`;
    }
    if (msg) setAnnouncement(msg);
    prevTasksRef.current = cur;
  }, [doc]);

  // Global keyboard model (BRIEF §3). Skipped when typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      // A modal/dialog/menu owns the keyboard: never let app shortcuts act on the
      // list sitting behind the backdrop (the old, leaky helpOpen/overflowOpen
      // special-cases). Every modal registers a scope while open and handles its
      // own Esc/close; here we just bail out uniformly.
      if (isModalScopeActive()) return;

      // Cmd/Ctrl+K opens the palette from anywhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      // Cmd/Ctrl+Z = undo · Cmd/Ctrl+Shift+Z = redo — work from anywhere except
      // while typing in a field (so the input's own undo isn't hijacked).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }

      // Cmd/Ctrl+S saves and Cmd/Ctrl+O opens a .rune file — bound explicitly so
      // the browser's own Save/Open dialogs never fire (matching the palette
      // keycaps). These work from anywhere, including while typing in a field.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openFile();
        return;
      }

      if (typing) return;

      // `?` opens the shortcuts + capture-grammar help sheet.
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      // `/` reveals the Document-view filter (a slim hairline input; it collapses
      // and resets on Esc / empty blur). Document view only.
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (view === 'document') {
          e.preventDefault();
          setFilterOpen(true);
        }
        return;
      }

      // `c` focuses the quick-add bar.
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        quickAddRef.current?.focus();
        return;
      }

      // Shift+Enter on a selected row = add a child and edit it inline.
      if (e.key === 'Enter' && e.shiftKey && selectedId && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const childId = addChild(selectedId);
        if (childId) {
          select(childId);
          setEditingId(childId);
        }
        return;
      }

      // `e` enters inline edit on the selected row.
      if (e.key === 'e' && selectedId && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setEditingId(selectedId);
        return;
      }

      // Backspace / Delete removes the selection (one row, or the whole
      // multi-selection as ONE commit), with a calm scoped-Undo toast.
      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
        e.preventDefault();
        deleteSelection();
        return;
      }

      const ids = visibleTaskIds();
      const cur = selectedId ? ids.indexOf(selectedId) : -1;

      // Shift+j/k (and Shift+arrows) EXTEND the selection range from the anchor
      // over the visible rows; plain j/k below collapses back to a single row.
      const shiftDown = e.shiftKey && (e.key === 'J' || e.key === 'ArrowDown');
      const shiftUp = e.shiftKey && (e.key === 'K' || e.key === 'ArrowUp');
      if ((shiftDown || shiftUp) && !e.metaKey && !e.ctrlKey && ids.length > 0) {
        e.preventDefault();
        const next = cur === -1
          ? ids[0]
          : ids[Math.max(0, Math.min(ids.length - 1, cur + (shiftDown ? 1 : -1)))];
        if (next) selectRange(next, ids);
        return;
      }

      // Cmd/Ctrl + Up/Down reorders the selected row.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (selectedId) {
          e.preventDefault();
          move(selectedId, e.key === 'ArrowUp' ? 'up' : 'down');
        }
        return;
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault();
          const next = ids[Math.min(ids.length - 1, cur + 1)] ?? ids[0];
          if (next) select(next);
          break;
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault();
          const prev = ids[Math.max(0, cur - 1)] ?? ids[0];
          if (prev) select(prev);
          break;
        }
        case ' ':
        case 'Enter': {
          if (selectedIds.length > 1) {
            e.preventDefault();
            toggleManyDone(selectedIds); // one commit, one undo step
          } else if (selectedId) {
            e.preventDefault();
            toggle(selectedId);
          }
          break;
        }
        case 'Tab': {
          if (selectedIds.length > 1) {
            e.preventDefault();
            if (e.shiftKey) outdentMany(selectedIds);
            else indentMany(selectedIds);
          } else if (selectedId) {
            e.preventDefault();
            if (e.shiftKey) outdent(selectedId);
            else indent(selectedId);
          }
          break;
        }
        case 'o': {
          if (selectedId) {
            e.preventDefault();
            setDetailId(selectedId);
          }
          break;
        }
        case 'Escape': {
          if (editingId) setEditingId(null);
          else if (detailId) setDetailId(null);
          else if (selectedIds.length > 1) select(selectedId); // collapse to single
          else select(null);
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    selectedId,
    selectedIds,
    detailId,
    editingId,
    view,
    select,
    selectRange,
    toggle,
    toggleManyDone,
    indent,
    outdent,
    indentMany,
    outdentMany,
    move,
    deleteSelection,
    addChild,
    undo,
    redo,
    save,
    openFile,
    showToast,
  ]);

  // The ids of the rows ACTUALLY on screen, in visual order — so j/k and reorder
  // follow the rendered list (respecting the current view + "hide done" + the
  // `/` filter), not the raw doc order.
  function visibleTaskIds(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.rune-row[data-id]'))
      .map((el) => el.dataset.id ?? '')
      .filter(Boolean);
  }

  // Shift-click on a row: extend the selection range from the anchor over the
  // rows as rendered (same DOM walk the keyboard uses).
  const onSelectRange = (id: string): void => selectRange(id, visibleTaskIds());

  return (
    <div className="rune-app">
      <header className="rune-topbar">
        <div className="rune-topbar-left">
          <span className="rune-wordmark">Rune</span>
          <nav className="rune-viewswitch">
            <ViewTab name="document" label="Document" view={view} setView={setView} />
            <ViewTab name="today" label="Today" view={view} setView={setView} count={todayCount} />
            <ViewTab name="sequence" label="Sequence" view={view} setView={setView} />
            <ViewTab name="source" label="Source" view={view} setView={setView} />
            <ViewTab name="board" label="Board" view={view} setView={setView} />
            <ViewTab name="notes" label="Notes" view={view} setView={setView} />
          </nav>
          <button
            type="button"
            className={`rune-chrome-btn rune-hidedone${hideDone ? ' is-active' : ''}`}
            aria-pressed={hideDone}
            title={hideDone ? 'Completed tasks are hidden — click to show them' : 'Hide completed tasks'}
            onClick={() => setHideDone(!hideDone)}
          >
            {hideDone ? 'Show done' : 'Hide done'}
          </button>
        </div>
        <div className="rune-topbar-right">
          {fileName && <span className="rune-filename">{fileName}</span>}
          {fileReconnectNeeded && (
            <button
              type="button"
              className="rune-chrome-btn rune-reconnect"
              title="Your file needs permission again before changes can be saved to disk"
              onClick={() => void reconnectFile()}
            >
              Reconnect file
            </button>
          )}
          {/* Desktop (>640px): actions sit inline. Mobile: this row is hidden by
              CSS and the same actions move into the ⋯ overflow popover below. */}
          <div className="rune-topbar-actions">
            <OverflowActions
              syncStatus={syncStatus}
              syncError={syncError}
              theme={theme}
              onReview={() => setReviewOpen(true)}
              onShare={() => setShareOpen(true)}
              onSync={() => setSyncOpen(true)}
              onOpenFile={() => void openFile()}
              onOpenFolder={() => void openFolder()}
              onSave={() => void save()}
              onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            />
          </div>
          {/* Mobile-only: a single quiet ⋯ button opening a calm popover menu. */}
          <div className="rune-overflow">
            <button
              type="button"
              className="rune-chrome-btn rune-overflow-btn"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              aria-label="More actions"
              title="More actions"
              onClick={() => setOverflowOpen((v) => !v)}
            >
              {syncStatus !== 'off' && (
                <span
                  className={`rune-sync-dot${syncStatus === 'syncing' ? ' is-syncing' : ''}${
                    syncStatus === 'error' ? ' is-error' : ''
                  }`}
                  aria-hidden="true"
                />
              )}
              ⋯
            </button>
            {overflowOpen && (
              <>
                <div
                  className="rune-overflow-scrim"
                  aria-hidden="true"
                  onClick={() => setOverflowOpen(false)}
                />
                <div className="rune-overflow-menu" role="menu">
                  <OverflowActions
                    menu
                    syncStatus={syncStatus}
                    syncError={syncError}
                    theme={theme}
                    onReview={() => {
                      setOverflowOpen(false);
                      setReviewOpen(true);
                    }}
                    onShare={() => {
                      setOverflowOpen(false);
                      setShareOpen(true);
                    }}
                    onSync={() => {
                      setOverflowOpen(false);
                      setSyncOpen(true);
                    }}
                    onOpenFile={() => {
                      setOverflowOpen(false);
                      void openFile();
                    }}
                    onOpenFolder={() => {
                      setOverflowOpen(false);
                      void openFolder();
                    }}
                    onSave={() => {
                      setOverflowOpen(false);
                      void save();
                    }}
                    onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {view !== 'notes' && view !== 'board' && (
        <QuickAdd
          ref={quickAddRef}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpen={setDetailId}
          onNotice={showToast}
        />
      )}

      <main className="rune-main">
        {view === 'document' && (
          <DocumentView
            onOpen={setDetailId}
            editingId={editingId}
            onEdit={onEdit}
            onDelete={onDelete}
            onEditCommit={onEditCommit}
            onEditCancel={onEditCancel}
            onSelectRange={onSelectRange}
            filterOpen={filterOpen}
            onFilterCollapse={() => setFilterOpen(false)}
          />
        )}
        {view === 'today' && (
          <TodayView
            onOpen={setDetailId}
            editingId={editingId}
            onEdit={onEdit}
            onDelete={onDelete}
            onEditCommit={onEditCommit}
            onEditCancel={onEditCancel}
            onSelectRange={onSelectRange}
          />
        )}
        {view === 'sequence' && (
          <SequenceView
            onOpen={setDetailId}
            editingId={editingId}
            onEdit={onEdit}
            onDelete={onDelete}
            onEditCommit={onEditCommit}
            onEditCancel={onEditCancel}
            onSelectRange={onSelectRange}
          />
        )}
        {view === 'source' && <SourceView onOpen={setDetailId} />}
        {view === 'board' && <BoardView onOpen={setDetailId} />}
        {view === 'notes' && <NotesView onNotice={showToast} />}
      </main>

      {/* Key the card by id so retargeting (open A → j/k to B → o) fully remounts
          it — the previous task's uncommitted title draft can never survive and
          rename the new task. */}
      {detailId && (
        <DetailCard
          key={detailId}
          id={detailId}
          onClose={() => setDetailId(null)}
          onNotice={showToast}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onGoToView={(v) => setView(v)}
        onOpenHelp={() => setHelpOpen(true)}
        onNotice={showToast}
      />
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />
      <SyncDialog open={syncOpen} onClose={() => setSyncOpen(false)} />
      <ReviewModal open={reviewOpen} onClose={() => setReviewOpen(false)} />
      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SelectionBar onNotice={showToast} />
      {toast && (
        <Toast
          message={toast.message}
          onUndo={
            toast.undo
              ? () => {
                  toast.undo?.();
                  setToast(null);
                }
              : undefined
          }
          onDismiss={() => setToast(null)}
        />
      )}
      {/* One app-level polite live region: add/complete/delete are announced here
          for screen readers without any visible chrome. */}
      <div className="rune-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/** Toast state: a message plus an OPTIONAL undo callback. Only genuinely undoable
 *  actions pass `undo` (→ an Undo button); message-only toasts (sync failed, save
 *  error, conflict) omit it, so no Undo button offers to revert an unrelated edit. */
interface ToastState {
  message: string;
  undo?: () => void;
}

/** The secondary topbar actions (Review / Share / Sync / Open .rune / Open
 *  folder / Save / theme). Rendered inline on desktop and inside the mobile ⋯
 *  popover — one source of truth so the two can never drift. `menu` switches the
 *  styling from inline chrome buttons to quiet menu rows. */
function OverflowActions({
  menu = false,
  syncStatus,
  syncError,
  theme,
  onReview,
  onShare,
  onSync,
  onOpenFile,
  onOpenFolder,
  onSave,
  onToggleTheme,
}: {
  menu?: boolean;
  syncStatus: string;
  syncError: string | null;
  theme: string;
  onReview: () => void;
  onShare: () => void;
  onSync: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onSave: () => void;
  onToggleTheme: () => void;
}): JSX.Element {
  const cls = menu ? 'rune-overflow-item' : 'rune-chrome-btn';
  const role = menu ? 'menuitem' : undefined;
  return (
    <>
      <button
        type="button"
        className={cls}
        role={role}
        title="Review AI edits — paste an annotated copy of your list back in"
        onClick={onReview}
      >
        Review
      </button>
      <button
        type="button"
        className={cls}
        role={role}
        title="Publish a read-only link to this list"
        onClick={onShare}
      >
        Share
      </button>
      <button
        type="button"
        className={cls}
        role={role}
        title={
          syncStatus === 'error'
            ? `Sync error: ${syncError ?? 'unknown'}`
            : 'Sync this list across your devices'
        }
        onClick={onSync}
      >
        {/* The inline (desktop) button carries the sync dot; on mobile the dot
            rides the ⋯ button instead, so suppress it inside the menu. */}
        {!menu && syncStatus !== 'off' && (
          <span
            className={`rune-sync-dot${syncStatus === 'syncing' ? ' is-syncing' : ''}${
              syncStatus === 'error' ? ' is-error' : ''
            }`}
            aria-hidden="true"
          />
        )}
        Sync
      </button>
      <button type="button" className={cls} role={role} onClick={onOpenFile}>
        Open .rune
      </button>
      {/* "Open folder" is Chromium-only. Desktop keeps it exactly as before;
          the mobile menu hides it entirely where the API is absent. */}
      {(!menu || supportsDirectoryAccess()) && (
        <button
          type="button"
          className={cls}
          role={role}
          onClick={onOpenFolder}
          title="Open a folder that holds your .rune file — attachments are saved inside it (Chromium)"
        >
          Open folder
        </button>
      )}
      <button type="button" className={cls} role={role} onClick={onSave}>
        Save
      </button>
      <button
        type="button"
        className={cls}
        role={role}
        onClick={onToggleTheme}
        aria-label="Toggle theme"
      >
        {menu ? (theme === 'dark' ? '◐ Light theme' : '◑ Dark theme') : theme === 'dark' ? '◐' : '◑'}
      </button>
    </>
  );
}

function ViewTab({
  name,
  label,
  view,
  setView,
  count,
}: {
  name: ViewName;
  label: string;
  view: ViewName;
  setView: (v: ViewName) => void;
  /** A quiet mute-ink count after the label ("Today ·3"). Zero/undefined renders
   *  NOTHING — absent, not "·0" (no anxiety chrome, no badge shape). */
  count?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`rune-viewtab${view === name ? ' is-active' : ''}`}
      onClick={() => setView(name)}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="rune-viewtab-count">·{count}</span>
      )}
    </button>
  );
}

/** A calm bottom-of-screen toast: one line, optionally with an Undo link and
 *  always a dismiss ✕. The Undo button renders ONLY when `onUndo` is provided —
 *  message-only toasts (sync failed, save error) show just the message. Auto-
 *  dismisses (handled by the caller's timer); quiet, no badge. Visual language is
 *  identical to before. */
function Toast({
  message,
  onUndo,
  onDismiss,
}: {
  message: string;
  onUndo?: () => void;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div className="rune-toast" role="status">
      <span className="rune-toast-msg">{message}</span>
      {onUndo && (
        <button type="button" className="rune-toast-undo" onClick={onUndo}>
          Undo
        </button>
      )}
      <button
        type="button"
        className="rune-toast-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}
