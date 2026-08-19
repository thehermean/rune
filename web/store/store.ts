// The Rune store (zustand).
//
// CONTRACT: the action/selector names and signatures in this file are what
// Wave 2 codes against. Do not rename them. The state model is intentionally
// thin: the .rune TEXT is canonical, `doc` is its parsed view, and every
// mutation is "parse -> mutate the Doc -> serialize -> autosave". There is never
// a second representation.

import { create } from 'zustand';
import type { Doc, Node, Segment, State, TaskNode } from '@core';
import { parse, serialize, tasks, findById, attachmentsOf } from '@core';
import { nextOccurrence } from '@core/recur';
import { parseInput, type CaptureResult } from '../lib/capture';
import { uniqueId } from '../lib/ids';
import { isColKey, stateForColumn, type ColKey } from '../lib/board';
import { toISO, parseDateStrict } from '../lib/dates';
import {
  removeTask,
  replaceBody,
  insertChild,
  insertSibling,
  insertComment,
  setCommentResolved,
  nextCommentId,
  moveBlock,
  moveBlockTo,
  descendantEndIndex,
} from '../lib/edit';
import {
  openWithPicker,
  readInputFile,
  writeHandle,
  downloadText,
  saveLocal,
  loadLocal,
  fetchSeed,
  supportsFileSystemAccess,
  supportsDirectoryAccess,
  openDirectory,
  writeAttachment,
  readAttachment,
  pullDoc,
  pushDoc,
  ensureWritePermission,
  saveHandles,
  loadHandles,
  type FsFileHandle,
  type FsDirHandle,
  type PushOptions,
} from '../lib/persist';

export type Theme = 'dark' | 'light';

/** A capture of a removed task block, enough to re-insert it later (undo a
 *  delete) INDEPENDENTLY of whatever else happened since. `block` is the raw
 *  `.rune` text of the removed lines; `afterId` anchors it to the nearest
 *  preceding task (null when it was at the top). {@link RuneState.restoreDeleted}
 *  re-inserts it; if the anchor no longer exists it appends at the end. */
export interface DeleteTicket {
  block: string;
  afterId: string | null;
}

/** A capture of a MULTI-block delete, restorable as a single undo step. The
 *  tickets are ordered by original document position so re-inserting them in
 *  order re-anchors correctly (an earlier block can be a later block's anchor).
 *  {@link RuneState.restoreDeletedMany} re-inserts them all in ONE commit. */
export interface BulkDeleteTicket {
  tickets: DeleteTicket[];
}

/** The lifecycle of the cross-device sync layer, surfaced to the SyncDialog. */
export type SyncStatus = 'off' | 'idle' | 'syncing' | 'synced' | 'error';

// localStorage keys for the sync layer (shared contract across agents).
const SYNC_TOKEN_KEY = 'rune:sync:token';
const SYNC_ENABLED_KEY = 'rune:sync:enabled';
// The server stamp we last synced to, and whether local has unpushed edits —
// persisted so a reload can reconcile without clobbering fresher local text.
const SYNC_UPDATED_KEY = 'rune:sync:updatedAt';
const SYNC_DIRTY_KEY = 'rune:sync:dirty';
// Set when the user EXPLICITLY turns sync off in the dialog; cleared when they
// enable it. While set, a trusted-network server is never auto-enabled on this
// device — an explicit "no" must stick.
const SYNC_OPTOUT_KEY = 'rune:sync:optout';
// Set when the store initialised from the BUNDLED onboarding seed (a fresh device
// with no localStorage doc). While set, the local text is the pristine seed — it
// is NEVER sync-authoritative: it is never pushed, and a non-empty server doc is
// adopted unconditionally. Cleared permanently on the first user-driven commit.
const SYNC_PRISTINE_KEY = 'rune:pristine';
// UI preferences persisted across reloads (mirrors the hideDone key below).
const THEME_KEY = 'rune:theme';

/** How long after the last mutation before a debounced push fires (ms). */
const SYNC_DEBOUNCE_MS = 1500;

/** At most one quiet pull-on-focus per this window (ms). Offline tabs regain
 *  focus constantly, so we never pull more often than this. */
const FOCUS_PULL_THROTTLE_MS = 15_000;

/** How long after the last mutation before the open file is written through (ms). */
const FILE_WRITE_DEBOUNCE_MS = 1000;

export interface RuneState {
  // --- state ---
  text: string;
  doc: Doc;
  /** The focused / lead task (the anchor for single-row actions). */
  selectedId: string | null;
  /** The full multi-select set (ALWAYS includes selectedId; `[]` when nothing is
   *  selected, `[selectedId]` for a single selection). Bulk verbs act over this
   *  when its length > 1. */
  selectedIds: string[];
  /** The fixed anchor a range selection extends from (shift-click / shift-j/k).
   *  Set to selectedId on every plain (collapsing) selection. */
  anchorId: string | null;
  /** True in touch "select mode" (entered by long-press): a tap toggles a
   *  row into the multi-selection instead of opening the inspector. */
  selectMode: boolean;
  theme: Theme;
  /** When true, the Document view hides done tasks (and their sub-items). */
  hideDone: boolean;
  fileName: string | null;
  /** Live FS handle when a real file is open; null on the localStorage path. */
  fileHandle: FsFileHandle | null;
  /** Live FS directory handle when a FOLDER is open; enables storing attachment
   *  bytes in <folder>/attachments/ (Chromium only). Null otherwise. */
  dirHandle: FsDirHandle | null;
  /** Undo history: previous `text` snapshots, oldest first (bounded). */
  undoStack: string[];
  /** Redo history: undone `text` snapshots, most-recent first. */
  redoStack: string[];
  /** True when there is at least one undo step available. */
  canUndo: boolean;
  /** True when there is at least one redo step available. */
  canRedo: boolean;
  /** The author name stamped on comments this user authors (default "ben"). */
  author: string;

  // --- persistence health ---
  /** True while an edit is still waiting to be written through to the open file
   *  handle (drives the beforeunload guard). */
  dirty: boolean;
  /** Set when the open file handle needs its permission re-granted before we can
   *  write to it again (restored handle after a reload). Drives a "Reconnect
   *  file" affordance. */
  fileReconnectNeeded: boolean;
  /** A one-shot persistence error message (quota / blocked storage / failed file
   *  write) for the App to surface as a toast, or null. */
  saveError: string | null;

  // --- cross-device sync (app-side layer over same-origin /api/doc) ---
  /** True when sync is turned on (mirrored to localStorage `rune:sync:enabled`). */
  syncEnabled: boolean;
  /** The shared bearer token. `null` = not configured; `''` = configured for a
   *  trusted-network ("open") server that needs no token; a non-empty string = a
   *  bearer token. Mirrored to localStorage `rune:sync:token`. */
  syncToken: string | null;
  /** True when the server is known to sync WITHOUT a token (trusted-network /
   *  RUNE_OPEN_SYNC). Drives the SyncDialog: hide the token field, show "Syncing
   *  with this server". Set by a successful token-less probe. */
  syncOpen: boolean;
  /** Current sync lifecycle for the SyncDialog. "off" until enabled. */
  syncStatus: SyncStatus;
  /** ISO timestamp of the last successful push/pull, or null. */
  syncLastAt: string | null;
  /** Last sync error message (for the SyncDialog), or null when healthy. */
  syncError: string | null;
  /** The server updatedAt we last synced to; the conditional-PUT precondition.
   *  Mirrored to localStorage so a reload can tell whether local diverged. */
  lastSyncedUpdatedAt: string | null;
  /** True when the local text has unpushed changes (mirrored to localStorage). */
  syncDirty: boolean;
  /** True when a push hit a real conflict: the server changed under us and its
   *  text differs from ours. Local text is kept intact; resolve via the dialog. */
  syncConflict: boolean;
  /** The conflicting server text/stamp (kept for the "Reload" resolution). */
  conflictText: string | null;
  conflictUpdatedAt: string | null;

  // --- lifecycle ---
  /** Replace the whole document from raw text (reparse + autosave). */
  loadText(text: string): void;
  /** Resolve the initial document: localStorage if present, else the seed file. */
  init(): Promise<void>;

  // --- file IO ---
  openFile(): Promise<void>;
  /** Open a FOLDER holding the .rune file; enables byte-stored attachments. */
  openFolder(): Promise<void>;
  save(): Promise<void>;
  /** Attach a real file: copy its bytes into <folder>/attachments/ when a folder
   *  is open, else record a reference. */
  attachFile(id: string, file: File): Promise<void>;
  /** Open an attachment: a URL in a new tab, or a stored file read from the folder. */
  openAttachment(target: string): Promise<void>;

  // --- mutations (all reserialize + autosave + push undo) ---
  addFromInput(input: string, opts?: { open?: boolean }): string | null;
  toggle(id: string): void;
  setState(id: string, state: State): void;
  indent(id: string): void;
  outdent(id: string): void;
  move(id: string, dir: 'up' | 'down'): void;
  /** Board (kanban): move a `#board` card to a target column. Sets the card's
   *  `col:<slug>` token AND its state (so the two never drift), in ONE commit
   *  through the normal mutation path — only that item's line is touched, every
   *  other card's col: round-trips untouched. No-op for an unknown id or column,
   *  or when the card is already in that column with the matching state. */
  moveToColumn(id: string, col: ColKey): void;
  /** Drag-reorder: move `sourceId`'s block to sit before/after `targetId`'s
   *  block. Sibling-scoped (see moveBlockTo); a cross-section/indent drop is a
   *  no-op. */
  moveTo(sourceId: string, targetId: string, place: 'before' | 'after'): void;
  /** Replace the whole document text (undoable). `opts.coalesceKey` folds a burst
   *  of edits (e.g. keystrokes in the Source view) into one undo step. */
  setText(text: string, opts?: CommitOptions): void;

  // --- editing (Wave: editing layer) ---
  /** Remove a task line and its descendant block. */
  remove(id: string): void;
  /** Remove many task blocks in a SINGLE commit (one undo step, one sync push).
   *  Ids resolving to the same block or to already-removed descendants are
   *  skipped; a fully no-op call pushes nothing. */
  removeMany(ids: string[]): void;
  /** Remove a task block and return a ticket to restore it later (scoped delete
   *  undo). Returns null for an unknown id. */
  removeTaskWithTicket(id: string): DeleteTicket | null;
  /** Re-insert a block captured by {@link removeTaskWithTicket} as a normal
   *  (undoable) commit — anchored after its original predecessor when that still
   *  exists, else appended at the end. */
  restoreDeleted(ticket: DeleteTicket): void;
  /** Remove many task blocks in ONE commit and return a bulk ticket that
   *  restores them all in ONE commit (a single undo step for the toast). Returns
   *  null when nothing resolvable was passed. */
  removeManyWithTicket(ids: string[]): BulkDeleteTicket | null;
  /** Re-insert every block captured by {@link removeManyWithTicket} in a SINGLE
   *  (undoable) commit. */
  restoreDeletedMany(bulk: BulkDeleteTicket): void;
  /** Replace the task body (text after `- [state] `, before ` ^id`). */
  setBody(id: string, body: string): void;
  /** Add a child task under `parentId`; returns the new id (null if no parent).
   *  Empty/undefined input -> an empty `- [ ]` child. */
  addChild(parentId: string, input?: string): string | null;
  /** Add a sibling after `afterId`; returns the new id (null if no afterId). */
  addSibling(afterId: string, input?: string): string | null;
  /** Set priority 0..3 (0 clears, 1..3 sets the `!`-count). */
  setPriority(id: string, level: number): void;
  /** Set due: from a natural-language/ISO date input (`""` clears it). Returns
   *  true when the change was applied, false when the input was unparseable (so
   *  a caller can surface a "Couldn't read that date" notice). */
  setDue(id: string, dateInput: string): boolean;
  /** Toggle a `#tag` on a task (no leading `#`). */
  toggleTag(id: string, tag: string): void;
  /** Set/replace the `after:` dependency csv (`[]` clears it). */
  setAfter(id: string, deps: string[]): void;
  /** Replace only the leading title words, keeping all other tokens. */
  rename(id: string, title: string): void;
  /** Append a `[label](target)` attachment link to the task body. */
  addAttachment(id: string, label: string, target: string): void;
  /** Remove the attachment link/segment whose target matches `target`. */
  removeAttachment(id: string, target: string): void;

  // --- Wave 5: contexts, scheduling, recurrence, comments ---
  /** Toggle an `@ctx` context token on a task (no leading `@`). */
  toggleContext(id: string, ctx: string): void;
  /** Set/clear `scheduled:` from a natural-language/ISO date (`""` clears). */
  setScheduled(id: string, dateInput: string): void;
  /** Set `recur:` (rolling=false) or `recur!:` (rolling=true) to an english rule;
   *  empty rule clears both keys. */
  setRecurrence(id: string, rule: string, rolling: boolean): void;
  /** Set the comment author name stamped on new comments. */
  setAuthor(name: string): void;
  /** Add a comment to a task, authored by the current `author`. No-op on empty. */
  addComment(itemId: string, body: string): void;
  /** Reply to an existing comment thread on a task. No-op on empty. */
  replyToComment(itemId: string, parentCommentId: string, body: string): void;
  /** Mark a standalone comment resolved/unresolved by its comment id. */
  resolveComment(commentId: string, resolved: boolean): void;

  /** Undo / redo the last committed mutation. */
  undo(): void;
  redo(): void;

  // --- cross-device sync actions ---
  /** Set the shared bearer token (persisted to localStorage). "" clears it. */
  setSyncToken(token: string): void;
  /** Turn sync on/off. On the first enable: pull the server doc — if it is empty
   *  seed it with the local text, otherwise adopt the synced list (loadText). */
  enableSync(on: boolean): Promise<void>;
  /** Push the current text to the server now (manual "Sync now"). */
  syncNow(): Promise<void>;
  /** Resolve a conflict by adopting the server's version (replaces local text). */
  reloadFromSync(): void;
  /** Resolve a conflict by keeping local — the next push overwrites the server. */
  dismissConflict(): void;

  // --- persistence recovery ---
  /** Re-grant write permission on a restored file handle (user gesture) and flush
   *  the current text to it. */
  reconnectFile(): Promise<void>;
  /** Acknowledge (clear) the one-shot saveError after the App has toasted it. */
  ackSaveError(): void;

  // --- bulk verbs (multi-select; each funnels existing single transforms over
  //     ONE commit, so it is a single undo step) ---
  /** Toggle done over a set: if EVERY id is done → open them all, else → done
   *  them all (with done stamping + recurrence spawn, exactly like toggle). */
  toggleManyDone(ids: string[]): void;
  /** Set the same state on every id in one commit. */
  setStateMany(ids: string[], state: State): void;
  /** Set the same priority (0..3) on every id in one commit. */
  setPriorityMany(ids: string[], level: number): void;
  /** Add a `#tag` (no leading `#`) to every id that lacks it, in one commit. */
  addTagMany(ids: string[], tag: string): void;
  /** Set the same due date (natural language or ISO; empty clears) on every id
   *  in one commit. Returns false (no change) when the date can't be parsed. */
  setDueMany(ids: string[], dateInput: string): boolean;
  /** Indent every id (and its block) one level, in one commit. */
  indentMany(ids: string[]): void;
  /** Outdent every id (and its block) one level, in one commit. */
  outdentMany(ids: string[]): void;

  // --- selection / theme ---
  /** Select a single row (collapses any multi-selection). null clears it. Also
   *  resets the range anchor to this row. */
  select(id: string | null): void;
  /** Extend the selection from the current anchor to `leadId` across the given
   *  visible-row order (shift-click / shift-j/k). `leadId` becomes the new lead
   *  (selectedId); the anchor is preserved. */
  selectRange(leadId: string, visibleIds: string[]): void;
  /** Toggle a single row in/out of the multi-selection (ctrl/cmd-click). The
   *  toggled row becomes the lead + anchor; removing the last one clears it. */
  toggleSelect(id: string): void;
  /** Clear the whole selection (the selection bar's Clear / Esc). */
  clearSelection(): void;
  /** Enter touch select mode (long-press): ensure `id` is selected and flip
   *  selectMode on so taps toggle rows. Pass null to just flip it on. */
  enterSelectMode(id: string | null): void;
  setTheme(t: Theme): void;
  /** Hide completed (done) tasks and their sub-items in the Document view. */
  setHideDone(on: boolean): void;
}

// State -> the single canonical char the serializer writes.
const STATE_CHAR: Record<State, string> = {
  open: ' ',
  done: 'x',
  doing: '/',
  cancelled: '-',
  deferred: '>',
};

/** Max retained undo steps. Old steps drop off the front when exceeded. */
const HISTORY_LIMIT = 100;

/** Options for the mutation funnel. */
export interface CommitOptions {
  /** When two consecutive commits carry the SAME non-null key, the second (and
   *  each further one) folds into the first's undo step instead of pushing a new
   *  one — a burst of edits (e.g. typing in the Source view) becomes ONE undo. */
  coalesceKey?: string;
  /** Drop the commit entirely when the resulting text is byte-identical to the
   *  current text. Defaults to TRUE — this kills phantom undo entries (setDue to
   *  the same value, outdent at indent 0, a no-op move, …). Pass false only for a
   *  path that must force a commit even for equal text (none today). */
  skipIfEqual?: boolean;
}

/** The coalesceKey of the most recent commit (module scope so a burst of edits
 *  folds into one undo step). Reset to null by any non-coalescing commit and by
 *  undo/redo, so a new burst always starts a fresh undo step. */
let lastCoalesceKey: string | null = null;

/**
 * The single mutation funnel. Accepts either a next Doc or next text, re-derives
 * the missing half, PUSHES the previous text onto the bounded undo stack, CLEARS
 * the redo stack, updates {text, doc}, and autosaves. Every mutating action
 * routes through here so undo works uniformly across the whole app.
 *
 * `skipIfEqual` (default true) drops a no-op commit so callers no longer need to
 * hand-guard "did the text actually change?". `coalesceKey` merges a burst of
 * same-key commits into a single undo step.
 */
function commit(next: Doc | string, set: SetFn, get: GetFn, opts?: CommitOptions): void {
  const prevText = get().text;
  const text = typeof next === 'string' ? next : serialize(next);
  const skipIfEqual = opts?.skipIfEqual ?? true;
  if (skipIfEqual && text === prevText) return;

  // The first user-driven mutation makes the doc real: the onboarding seed is no
  // longer pristine, so ordinary sync (push/conflict) applies from here on.
  clearPristine();

  const doc = typeof next === 'string' ? parse(next) : next;

  const key = opts?.coalesceKey ?? null;
  // Coalesce: when this commit shares a non-null key with the immediately
  // preceding one, the top undo entry already captures the pre-burst text — leave
  // the stack untouched so one undo reverts the whole burst.
  const coalesce = key !== null && key === lastCoalesceKey && get().undoStack.length > 0;

  let undoStack = get().undoStack;
  if (!coalesce) {
    undoStack = [...undoStack, prevText];
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  }
  lastCoalesceKey = key;

  set({ doc, text, undoStack, redoStack: [], canUndo: undoStack.length > 0, canRedo: false });
  persistAfterChange(text, get, set);
}

type SetFn = (partial: Partial<RuneState>) => void;
type GetFn = () => RuneState;

/**
 * The single persistence funnel for a NEW canonical text. Called by commit(),
 * undo() and redo() — every path that produces text the user must not lose.
 * Deliberately NOT called by loadText(): adopting text FROM a source must not
 * immediately write it back. Three sinks, each guarded so a failure in one never
 * throws into the editing path:
 *   1. localStorage (always) — surfaces quota/blocked storage as saveError.
 *   2. the open file handle (debounced ~1s) — the source of truth on disk.
 *   3. cross-device sync (debounced ~1.5s) — when enabled.
 */
function persistAfterChange(text: string, get: GetFn, set: SetFn): void {
  if (!saveLocal(text, get().fileName)) {
    set({ saveError: "Couldn't autosave — storage is full or blocked." });
  }
  scheduleFileWrite(get, set);
  if (get().syncEnabled && get().syncToken !== null) {
    set({ syncDirty: true });
    lsSet(SYNC_DIRTY_KEY, '1');
    scheduleSyncPush(get, set);
  }
}

/** Index of the doc node for a task id, or -1. */
function nodeIndexById(doc: Doc, id: string): number {
  return doc.nodes.findIndex((n) => n.type === 'task' && n.id === id);
}

/** After a mutation that may have removed rows, prune the selection: drop any
 *  selectedIds that no longer resolve, and clear selectedId when it is gone. */
function pruneSelection(get: GetFn, set: SetFn): void {
  const doc = get().doc;
  const before = get().selectedIds;
  const ids = before.filter((id) => findById(doc, id));
  const patch: Partial<RuneState> = {};
  if (ids.length !== before.length) patch.selectedIds = ids;
  const sel = get().selectedId;
  if (sel && !findById(doc, sel)) patch.selectedId = null;
  const anchor = get().anchorId;
  if (anchor && !findById(doc, anchor)) patch.anchorId = null;
  if (Object.keys(patch).length) set(patch);
}

/** All current ids (for collision-free id minting). */
function existingIds(doc: Doc): string[] {
  return tasks(doc)
    .map((t) => t.id)
    .filter((x): x is string => x !== null);
}

/** Build a canonical `- [ ] <body>` line from a parsed capture, WITHOUT an id
 *  (the store stamps the id by mutating the parsed node, so serialize forces it
 *  trailing per the format). */
function lineFromCapture(c: CaptureResult): string {
  const parts: string[] = [];
  if (c.title) parts.push(c.title);
  for (const t of c.tags) parts.push(`#${t}`);
  for (const ctx of c.contexts) parts.push(`@${ctx}`);
  if (c.priority > 0) parts.push('!'.repeat(c.priority));
  for (const [k, v] of Object.entries(c.keys)) {
    parts.push(needsQuote(v) ? `${k}:"${v}"` : `${k}:${v}`);
  }
  // Bare URLs become `[link](url)` attachment tokens (reuse the same encoder the
  // attachment path uses, so parens/whitespace survive serialize(parse(line))).
  for (const url of c.links) parts.push(markdownLink('link', url));
  const body = parts.join(' ').trim();
  return `- [ ] ${body}`;
}

function needsQuote(v: string): boolean {
  return /\s/.test(v);
}

/** Coerce free text into a valid tag/context token. The format only allows
 *  [A-Za-z0-9_/-], so collapse whitespace to '-' and drop other chars — this
 *  stops a "#my tag" (with a space) from corrupting the line on round-trip. */
function slugToken(s: string): string {
  return s.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_/-]/g, '');
}

/** Parse a quick-add input into its canonical body string (no `- [ ] ` prefix,
 *  no trailing id). Empty/meaningless input -> "". */
function canonicalBody(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const c = parseInput(trimmed);
  return lineFromCapture(c).replace(/^- \[ \] ?/, '').trim();
}

/** A targeted change to a task body, applied by {@link rebuildBody}. Only the
 *  fields present are touched; everything else is preserved verbatim. */
interface BodyChange {
  /** Replace the leading title words (the `text` segments). */
  title?: string;
  /** Set/clear the priority token (`"!!"` etc., or null to remove). */
  priority?: string | null;
  /** Add a tag (no leading `#`) if absent. */
  addTag?: string;
  /** Remove a tag (no leading `#`) if present. */
  removeTag?: string;
  /** Add a context (no leading `@`) if absent. */
  addContext?: string;
  /** Remove a context (no leading `@`) if present. */
  removeContext?: string;
  /** Set (value) or clear (null) a key token, preserving position when present. */
  keys?: Record<string, string | null>;
}

/**
 * Rebuild a task's body string (the part between `- [state] ` and ` ^id`) from
 * its current segments with `change` applied. Order is preserved: existing
 * tokens keep their place; new tokens append. The result is fed back through
 * `replaceBody`, which re-parses it with @core — so this only has to produce
 * correct raw token text, not a parsed structure.
 */
function rebuildBody(task: TaskNode, change: BodyChange): string {
  const out: string[] = [];
  let titleEmitted = false;
  const keys = change.keys ?? {};
  const handledKeys = new Set<string>();

  for (const seg of task.segments) {
    if (seg.kind === 'text') {
      // Collapse the run of title words into the (possibly replaced) title once.
      if (change.title !== undefined) {
        if (!titleEmitted) {
          if (change.title) out.push(change.title);
          titleEmitted = true;
        }
        continue;
      }
      out.push(seg.raw);
      continue;
    }

    if (seg.kind === 'priority' && change.priority !== undefined) {
      if (change.priority) out.push(change.priority); // null -> drop
      continue;
    }

    if (seg.kind === 'tag' && change.removeTag && seg.value === change.removeTag) {
      continue; // drop this tag
    }

    if (
      seg.kind === 'context' &&
      change.removeContext &&
      seg.value === change.removeContext
    ) {
      continue; // drop this context
    }

    if (seg.kind === 'key' && seg.key && seg.key in keys) {
      handledKeys.add(seg.key);
      const v = keys[seg.key];
      if (v !== null) out.push(formatKey(seg.key, v)); // null -> drop the key
      continue;
    }

    out.push(seg.raw);
  }

  // A title set on a task with no existing text segments still needs emitting,
  // at the front of the body.
  if (change.title !== undefined && !titleEmitted && change.title) {
    out.unshift(change.title);
  }

  // Set a priority that had no existing token.
  if (change.priority !== undefined && change.priority &&
      !task.segments.some((s) => s.kind === 'priority')) {
    out.push(change.priority);
  }

  // Add a tag that was not already present.
  if (change.addTag) out.push(`#${change.addTag}`);

  // Add a context that was not already present.
  if (change.addContext) out.push(`@${change.addContext}`);

  // Append keys that were a fresh set (not replacing an existing token).
  for (const [k, v] of Object.entries(keys)) {
    if (v !== null && !handledKeys.has(k)) out.push(formatKey(k, v));
  }

  return out.join(' ').trim();
}

/** Render a key token, quoting the value when it contains whitespace. */
function formatKey(key: string, value: string): string {
  return needsQuote(value) ? `${key}:"${value}"` : `${key}:${value}`;
}

/** The task's existing canonical body (every segment's raw, in order) — the
 *  same string the inline editor pre-fills, minus prefix/id. New attachment links
 *  are appended to this. */
function canonicalBodyOf(task: TaskNode): string {
  return task.segments.map((s) => s.raw).join(' ').trim();
}

/** Encode a link target so it survives the `(...)` grammar. encodeURIComponent
 *  leaves '(' and ')' verbatim, but the link grammar stops the target at the
 *  first ')', so unescaped parens truncate the target and corrupt
 *  serialize(parse(line)). Percent-encode parens (and whitespace) explicitly.
 *  This is the EXACT form a target takes once stored/parsed, so dedup and
 *  removal compare against it. */
function encodeLinkTarget(target: string): string {
  return target.replace(/[()\s]/g, (ch) =>
    ch === '(' ? '%28' : ch === ')' ? '%29' : encodeURIComponent(ch),
  );
}

/** A `[label](target)` markdown link segment. Brackets/parens in the label and
 *  whitespace in the target would break the link grammar, so neutralise them. */
function markdownLink(label: string, target: string): string {
  const safeLabel = label.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim() || target;
  return `[${safeLabel}](${encodeLinkTarget(target)})`;
}

/** Read a localStorage string safely (private mode / no storage -> null). */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write/remove a localStorage string safely (swallow quota/private-mode errors). */
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the in-memory state remains authoritative this session.
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// --- pristine (onboarding seed) tracking -------------------------------------
//
// The bundled seed text, captured when init() loads it, so isPristine() can do a
// byte-identical belt-and-braces check even if the localStorage flag was lost
// (private mode, cleared storage). Null until/unless the seed was loaded.
let bundledSeedText: string | null = null;

/** True when local is still the pristine onboarding seed and so must NEVER be
 *  sync-authoritative (never pushed; a non-empty server is adopted wholesale).
 *  Primary signal is the persisted flag; the byte-identical seed check is a
 *  belt-and-braces fallback when the flag is unavailable. */
function isPristine(get: GetFn): boolean {
  if (lsGet(SYNC_PRISTINE_KEY) === '1') return true;
  return bundledSeedText !== null && get().text === bundledSeedText;
}

/** Permanently clear pristine — the local doc now holds real (user or adopted)
 *  content, so ordinary sync (push/conflict) applies from here on. */
function clearPristine(): void {
  lsSet(SYNC_PRISTINE_KEY, null);
}

// --- file write-through (debounced) ------------------------------------------
//
// Timer at module scope so a burst of edits coalesces into ONE write and it is
// never serialized into state.
let fileWriteTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule (or reschedule) a debounced write-through of the latest text to the
 *  open file handle. No-op when no file is open (localStorage is the store). */
function scheduleFileWrite(get: GetFn, set: SetFn): void {
  if (!get().fileHandle) return;
  set({ dirty: true });
  if (fileWriteTimer) clearTimeout(fileWriteTimer);
  fileWriteTimer = setTimeout(() => {
    fileWriteTimer = null;
    void flushFileWrite(get, set);
  }, FILE_WRITE_DEBOUNCE_MS);
}

/** Write the current text through the open file handle. Re-checks permission
 *  (a handle restored after a reload starts in the `prompt` state) and, when it
 *  is not yet granted, surfaces a quiet "Reconnect file" affordance rather than
 *  silently dropping the write. */
async function flushFileWrite(get: GetFn, set: SetFn): Promise<void> {
  const handle = get().fileHandle;
  if (!handle) {
    set({ dirty: false });
    return;
  }
  const text = get().text;
  const granted = await ensureWritePermission(handle, false);
  if (!granted) {
    set({
      fileReconnectNeeded: true,
      saveError: 'Reconnect your file to keep saving changes to disk.',
    });
    return;
  }
  try {
    await writeHandle(handle, text);
    // Only clear dirty when nothing has advanced past the bytes we just wrote.
    if (get().text === text) set({ dirty: false, fileReconnectNeeded: false });
  } catch (err) {
    set({ saveError: `Couldn't save to your file — ${errMsg(err)}` });
  }
}

// --- cross-device push (debounced) -------------------------------------------
//
// The debounced-push timer for sync. Lives at module scope (not in state) so it
// is never serialized and a single pending push is coalesced across mutations.
let syncPushTimer: ReturnType<typeof setTimeout> | null = null;

/** True while a push is actually in flight (awaiting the server). Lets the quiet
 *  pull-on-focus tell "a push is happening" apart from "idle" — it must never
 *  pull over a push that could still change the server stamp. */
let syncPushInFlight = false;
/** Timestamp (ms) of the last quiet pull-on-focus attempt, for throttling. */
let lastFocusPullAt = 0;
/** True while a quiet pull-on-focus is in flight, so two never overlap. */
let focusPullInFlight = false;

/** Record the server stamp we are now in sync with (state + localStorage). */
function setLastSynced(updatedAt: string, set: SetFn): void {
  set({ lastSyncedUpdatedAt: updatedAt });
  lsSet(SYNC_UPDATED_KEY, updatedAt || null);
}

/** Clear the sync-dirty flag, but only if nothing changed since `pushedText`
 *  went out (otherwise a later edit is still pending). */
function clearSyncDirtyIf(get: GetFn, set: SetFn, pushedText: string): void {
  if (get().text === pushedText) {
    set({ syncDirty: false });
    lsSet(SYNC_DIRTY_KEY, null);
  }
}

/**
 * Adopt a strictly-newer remote doc when local is clean: replace the text via
 * loadText (which CLEARS undo/redo history, exactly like the init adopt), record
 * the new server stamp, and drop the dirty flag. Shared by the init reconcile and
 * the quiet pull-on-focus so both behave identically.
 */
function adoptRemote(
  remote: { text: string; updatedAt: string },
  get: GetFn,
  set: SetFn,
): void {
  get().loadText(remote.text);
  // Adopting the server's doc means this device now tracks real synced content,
  // not the onboarding seed — it is no longer pristine.
  clearPristine();
  setLastSynced(remote.updatedAt, set);
  set({
    syncDirty: false,
    syncStatus: 'synced',
    syncLastAt: remote.updatedAt || new Date().toISOString(),
  });
  lsSet(SYNC_DIRTY_KEY, null);
}

/**
 * Push the current text once. EVERY push carries a precondition so it can never
 * silently clobber a divergent server doc:
 *   - a real lastSyncedUpdatedAt -> If-Match that stamp (a 409 becomes a quiet
 *     conflict, local kept intact);
 *   - never synced (null) -> an EXPECT-EMPTY precondition: the write only lands on
 *     a server with no doc yet, else 409. This is the fix for the incident where a
 *     fresh device unconditionally PUT its onboarding seed over a real list.
 *   - `force` (Keep-mine only) -> no precondition, an explicit user-sanctioned
 *     overwrite of a differing server doc.
 * Refuses to fire while the local doc is the pristine seed or while an unresolved
 * conflict is pending (unless forced). A sync failure NEVER throws into the
 * editing path — it is caught and surfaced as syncStatus "error".
 */
async function doPush(
  get: GetFn,
  set: SetFn,
  opts: { keepalive?: boolean; force?: boolean } = {},
): Promise<void> {
  const { keepalive = false, force = false } = opts;
  const { syncEnabled, syncToken } = get();
  if (!syncEnabled || syncToken === null) return;
  // Never auto-push the pristine onboarding seed, and never push over a surfaced
  // conflict — only an explicit force (Keep-mine) may overwrite a divergent server.
  if (!force && (isPristine(get) || get().syncConflict)) return;
  const pushedText = get().text;
  const last = get().lastSyncedUpdatedAt;
  set({ syncStatus: 'syncing', syncError: null });
  syncPushInFlight = true;
  try {
    // Precondition, always (unless force): real stamp -> If-Match; never synced ->
    // expect-empty. `force` sends none (unconditional, explicit overwrite).
    const pushOpts: PushOptions = force
      ? { keepalive }
      : last
        ? { ifMatch: last, keepalive }
        : { expectEmpty: true, keepalive };
    const res = await pushDoc(syncToken, pushedText, pushOpts);
    // Sync may have been turned off while the push was in flight.
    if (!get().syncEnabled) return;
    if (res.conflict) {
      if ((res.text ?? '') === get().text) {
        // The server already holds our content — just adopt its stamp.
        setLastSynced(res.updatedAt, set);
        clearSyncDirtyIf(get, set, pushedText);
        set({ syncStatus: 'synced', syncLastAt: new Date().toISOString(), syncError: null });
      } else {
        // Real divergence: keep local, surface a quiet conflict to resolve.
        set({
          syncConflict: true,
          conflictText: res.text ?? '',
          conflictUpdatedAt: res.updatedAt,
          syncStatus: 'synced',
          syncLastAt: new Date().toISOString(),
          syncError: null,
        });
      }
      return;
    }
    setLastSynced(res.updatedAt, set);
    clearSyncDirtyIf(get, set, pushedText);
    set({ syncStatus: 'synced', syncLastAt: new Date().toISOString(), syncError: null });
  } catch (err) {
    set({ syncStatus: 'error', syncError: errMsg(err) });
  } finally {
    syncPushInFlight = false;
  }
}

/**
 * Schedule (or reschedule) a single debounced push of the latest text. Called
 * from persistAfterChange() on every mutation when sync is enabled; the timer
 * resets each time so a burst of edits results in ONE push ~1.5s after the last
 * keystroke. Skipped while an unresolved conflict is pending so we don't loop on
 * repeated 409s (the dialog drives resolution).
 */
function scheduleSyncPush(get: GetFn, set: SetFn): void {
  // Never queue a push for the pristine seed, or over an unresolved conflict.
  if (isPristine(get) || get().syncConflict) return;
  if (syncPushTimer) clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    syncPushTimer = null;
    if (get().syncConflict || isPristine(get)) return;
    void doPush(get, set);
  }, SYNC_DEBOUNCE_MS);
}

/**
 * Quiet pull-on-focus. When the tab regains the foreground and sync is configured
 * with NOTHING local pending, pull the server doc; if it advanced past our
 * last-synced stamp while local is clean, adopt it silently through the SAME
 * loadText/adopt path the init reconcile uses. Preserves the Wave-1 safety model:
 * it only ever ADOPTS when there is nothing local to lose, and hands off entirely
 * to the push/conflict machinery the moment anything local is pending. Throttled
 * to once per FOCUS_PULL_THROTTLE_MS, never overlaps another pull, and swallows
 * all failures (an offline tab regains focus constantly — no toast, no status
 * change).
 */
async function maybeFocusPull(get: GetFn, set: SetFn): Promise<void> {
  const token = get().syncToken;
  // Configured AND enabled: an explicit "off" keeps the token but must stay off.
  if (token === null || !get().syncEnabled) return;
  // Anything local pending -> the push/conflict machinery owns it; don't pull.
  if (
    get().syncDirty ||
    get().syncConflict ||
    syncPushInFlight ||
    syncPushTimer !== null
  ) {
    return;
  }
  // Never overlap two pulls; throttle repeated focus/visibility events.
  if (focusPullInFlight) return;
  const now = Date.now();
  if (now - lastFocusPullAt < FOCUS_PULL_THROTTLE_MS) return;
  lastFocusPullAt = now;

  focusPullInFlight = true;
  const before = get().text;
  try {
    const remote = await pullDoc(token);
    if (!remote) return; // empty / never-written server: nothing to adopt
    // Await-race guard (mirrors enableSync): if local moved or went dirty while
    // the pull was in flight, leave it entirely to the push path.
    if (get().text !== before || get().syncDirty || get().syncConflict) return;
    // Server hasn't advanced past our last sync -> nothing to do.
    if (remote.updatedAt === get().lastSyncedUpdatedAt) return;
    if (remote.text === get().text) {
      // Same bytes under a newer stamp -> just record it (keep undo history).
      setLastSynced(remote.updatedAt, set);
      set({ syncDirty: false });
      lsSet(SYNC_DIRTY_KEY, null);
      return;
    }
    // Remote is genuinely newer and local is clean -> adopt it quietly.
    adoptRemote(remote, get, set);
  } catch {
    // Silent: offline tabs regain focus all the time. No toast, no status change.
  } finally {
    focusPullInFlight = false;
  }
}

// --- page lifecycle: flush pending writes before the tab goes away -----------

let lifecycleInstalled = false;

/** Install one-time visibilitychange/pagehide flushers and a beforeunload guard
 *  so a tab-close does not drop the last debounced file write or sync push.
 *  Feature-detected: a no-op where there is no window (the test runner). */
function installLifecycleHandlers(get: GetFn, set: SetFn): void {
  if (lifecycleInstalled || typeof window === 'undefined') return;
  lifecycleInstalled = true;

  const flush = (): void => {
    // Flush the pending sync push with keepalive so it survives the unload.
    if (
      get().syncEnabled &&
      get().syncToken !== null &&
      get().syncDirty &&
      !get().syncConflict
    ) {
      if (syncPushTimer) {
        clearTimeout(syncPushTimer);
        syncPushTimer = null;
      }
      void doPush(get, set, { keepalive: true });
    }
    // Best-effort file flush (the write is async; the OS may cut it short).
    if (get().dirty && get().fileHandle) {
      if (fileWriteTimer) {
        clearTimeout(fileWriteTimer);
        fileWriteTimer = null;
      }
      void flushFileWrite(get, set);
    }
  };

  // Regaining the foreground is a chance to quietly catch up on a doc another
  // device pushed while we were away (guarded: only ADOPTS when local is clean).
  const onForeground = (): void => {
    void maybeFocusPull(get, set);
  };
  window.addEventListener('visibilitychange', () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') flush();
    else if (document.visibilityState === 'visible') onForeground();
  });
  // Belt-and-braces: a plain window 'focus' also foregrounds the tab. Deduped
  // with visibilitychange by the pull's own throttle.
  window.addEventListener('focus', onForeground);
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    const filePending = get().dirty && !!get().fileHandle;
    const syncPending = get().syncDirty && !get().syncConflict && get().syncEnabled;
    if (filePending || syncPending) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/** Restore a file/dir handle persisted in IndexedDB from a previous session so
 *  the write-back binding survives a reload. The TEXT still comes from
 *  localStorage (we must not overwrite it with possibly-stale disk bytes); the
 *  restored handle's permission is re-checked lazily on the next write. */
async function restoreHandles(get: GetFn, set: SetFn): Promise<void> {
  try {
    const stored = await loadHandles();
    if (!stored || (!stored.fileHandle && !stored.dirHandle)) return;
    set({
      fileHandle: stored.fileHandle ?? null,
      dirHandle: stored.dirHandle ?? null,
      fileName: stored.fileName ?? get().fileName,
    });
  } catch {
    // No IDB / corrupt record — carry on with localStorage only.
  }
}

/**
 * Reconcile the local doc with the server when sync is enabled at startup.
 * Guards every clobber: adopts the remote doc ONLY when local has no unpushed
 * edits; when both sides changed it prefers local and surfaces a conflict rather
 * than silently discarding either side. Runs AFTER the local text is already
 * loaded into state.
 */
async function reconcileSyncOnInit(get: GetFn, set: SetFn): Promise<void> {
  const token = get().syncToken;
  // `null` = not configured; `''` = configured for an open (token-less) server —
  // both pullDoc/pushDoc handle the empty token by omitting the auth header.
  if (token === null) return;
  const localBefore = get().text;
  // "Dirty" if we have unpushed edits, if the user typed during the pull, or if
  // we have no record of a last sync (never reconciled -> err toward keeping
  // local, which enableSync's explicit adopt path can still override).
  const flaggedDirty = lsGet(SYNC_DIRTY_KEY) === '1';
  const lastSynced = get().lastSyncedUpdatedAt;

  set({ syncStatus: 'syncing', syncError: null });
  let remote: { text: string; updatedAt: string } | null;
  try {
    remote = await pullDoc(token);
  } catch (err) {
    set({ syncStatus: 'error', syncError: errMsg(err) });
    return;
  }

  // Pristine local (the onboarding seed) is NEVER sync-authoritative. Adopt a
  // non-empty server doc wholesale (no conflict, no push); leave an empty server
  // empty (never seed it with the onboarding doc — the incident's root cause).
  if (isPristine(get)) {
    if (remote) {
      adoptRemote(remote, get, set); // also clears pristine
    } else {
      set({ syncStatus: 'idle' });
    }
    return;
  }

  const editedDuringPull = get().text !== localBefore;
  const dirty = flaggedDirty || editedDuringPull || lastSynced === null;

  if (!remote) {
    // Empty server: seed it from local if we have something worth keeping.
    if (get().text.trim() !== '') {
      set({ syncDirty: true });
      lsSet(SYNC_DIRTY_KEY, '1');
      scheduleSyncPush(get, set);
      set({ syncStatus: 'idle' });
    } else {
      set({ syncStatus: 'idle' });
    }
    return;
  }

  const localText = get().text;
  if (remote.text === localText) {
    // Already identical — just record the stamp and go quiet.
    setLastSynced(remote.updatedAt, set);
    set({ syncDirty: false, syncStatus: 'synced', syncLastAt: remote.updatedAt || new Date().toISOString() });
    lsSet(SYNC_DIRTY_KEY, null);
    return;
  }

  const remoteChanged = remote.updatedAt !== lastSynced;
  if (!remoteChanged) {
    // Server hasn't moved since our last sync; only local diverged -> push it.
    setLastSynced(remote.updatedAt, set);
    set({ syncDirty: true, syncStatus: 'idle' });
    lsSet(SYNC_DIRTY_KEY, '1');
    scheduleSyncPush(get, set);
    return;
  }

  if (!dirty) {
    // Server advanced and we had no unpushed edits -> safe to adopt remote.
    adoptRemote(remote, get, set);
    return;
  }

  // Both sides changed -> prefer local, surface a conflict to resolve.
  set({
    syncConflict: true,
    conflictText: remote.text,
    conflictUpdatedAt: remote.updatedAt,
    syncStatus: 'synced',
    syncLastAt: remote.updatedAt || new Date().toISOString(),
  });
}

/** True when the app is served from a real web origin (not a bundled file://
 *  page and not a headless context with no location). Only there is a same-origin
 *  /api/doc probe meaningful. */
function servedFromRealOrigin(): boolean {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    return window.location.protocol !== 'file:';
  } catch {
    return false;
  }
}

/**
 * Zero-setup sync (trusted-network servers). When this device has NOT configured
 * sync (no token, sync off), has not explicitly opted out, and is served from a
 * real origin, probe /api/doc ONCE with no token. On an open server the probe
 * succeeds -> silently enable same-origin sync with an empty token and run the
 * SAME init reconcile (adopt-when-clean / seed-when-empty / conflict-guard, all
 * unchanged). On a 401 (token required) or any failure -> stay off, no noise.
 */
async function maybeAutoEnableSync(get: GetFn, set: SetFn): Promise<void> {
  if (get().syncEnabled || get().syncToken !== null) return; // already configured
  if (lsGet(SYNC_OPTOUT_KEY) === '1') return; // user said no — honour it
  if (!servedFromRealOrigin()) return;

  try {
    // The probe IS a token-less pull; a throw (401 / offline) means "not open".
    await pullDoc('');
  } catch {
    return; // token-gated or unreachable — stay quiet, manual flow unchanged
  }

  // Open server confirmed: enable sync with an empty token and persist it so a
  // reload re-syncs without re-probing.
  set({ syncEnabled: true, syncToken: '', syncOpen: true });
  lsSet(SYNC_ENABLED_KEY, '1');
  lsSet(SYNC_TOKEN_KEY, '');
  lsSet(SYNC_OPTOUT_KEY, null);
  await reconcileSyncOnInit(get, set);
}

export const useStore = create<RuneState>((set, get) => ({
  text: '',
  doc: { nodes: [] },
  selectedId: null,
  selectedIds: [],
  anchorId: null,
  selectMode: false,
  theme: lsGet(THEME_KEY) === 'light' ? 'light' : 'dark',
  hideDone: lsGet('rune:hidedone') !== '0',
  fileName: null,
  fileHandle: null,
  dirHandle: null,
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  author: 'ben',

  dirty: false,
  fileReconnectNeeded: false,
  saveError: null,

  // Sync: initialise from localStorage so a reload keeps the device in sync. A
  // stored empty-string token means this device auto-enabled against an open
  // server, so we already know the server needs no token (syncOpen).
  syncEnabled: lsGet(SYNC_ENABLED_KEY) === '1',
  syncToken: lsGet(SYNC_TOKEN_KEY),
  syncOpen: lsGet(SYNC_TOKEN_KEY) === '',
  syncStatus: lsGet(SYNC_ENABLED_KEY) === '1' ? 'idle' : 'off',
  syncLastAt: null,
  syncError: null,
  lastSyncedUpdatedAt: lsGet(SYNC_UPDATED_KEY),
  syncDirty: lsGet(SYNC_DIRTY_KEY) === '1',
  syncConflict: false,
  conflictText: null,
  conflictUpdatedAt: null,

  loadText(text) {
    const doc = parse(text);
    // A fresh document replaces the editing context: clear undo/redo history.
    set({ text, doc, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
    saveLocal(text, get().fileName);
  },

  async init() {
    // Wire the tab-lifecycle flushers before anything can go dirty.
    installLifecycleHandlers(get, set);

    // Reflect the persisted theme onto the document so a reload keeps it (state
    // was already seeded from localStorage at create()).
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', get().theme);
    }

    // 1. Establish the LOCAL baseline text first (localStorage, else the seed).
    //    Local is canonical for the session; sync reconciles against it below,
    //    never blindly clobbering it.
    const local = loadLocal();
    if (local) {
      set({ fileName: local.fileName });
      get().loadText(local.text);
    } else {
      // Fresh device: no localStorage doc. Whatever we load now (the bundled seed,
      // or empty) is PRISTINE — never sync-authoritative until the first real
      // commit. This flag is the guard that stops the onboarding seed from ever
      // being pushed over a real synced list.
      lsSet(SYNC_PRISTINE_KEY, '1');
      const seed = await fetchSeed();
      if (seed !== null) {
        bundledSeedText = seed; // captured for the byte-identical pristine fallback
        set({ fileName: 'work.rune' });
        get().loadText(seed);
      } else {
        // Nothing to load: start empty so the empty-state line shows.
        get().loadText('');
      }
    }

    // 2. Restore any persisted file/dir handle so write-back survives reloads.
    //    (Deliberately does NOT re-read disk over the local text.)
    await restoreHandles(get, set);

    // 3. Reconcile with the server when sync is on — dirty-aware, never
    //    clobbering fresher local edits (see reconcileSyncOnInit). When sync is
    //    NOT configured, try zero-setup auto-enable against a trusted-network
    //    server (probe; silent no-op when the server is token-gated or offline).
    if (get().syncEnabled && get().syncToken !== null) {
      await reconcileSyncOnInit(get, set);
    } else {
      await maybeAutoEnableSync(get, set);
    }
  },

  async openFile() {
    if (supportsFileSystemAccess()) {
      const opened = await openWithPicker();
      if (!opened) return;
      set({
        fileHandle: opened.handle,
        fileName: opened.name,
        dirty: false,
        fileReconnectNeeded: false,
      });
      get().loadText(opened.text);
      void saveHandles({
        fileHandle: opened.handle,
        dirHandle: get().dirHandle,
        fileName: opened.name,
      });
      return;
    }
    // Fallback: a hidden <input type=file> the App mounts is not available here,
    // so synthesize one.
    await new Promise<void>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.rune,.txt,.md,text/plain';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (file) {
          const opened = await readInputFile(file);
          // No live handle on this fallback path — drop any persisted one so a
          // later reload doesn't resurrect a stale binding.
          set({ fileHandle: null, fileName: opened.name, dirty: false, fileReconnectNeeded: false });
          void saveHandles({ fileHandle: null, dirHandle: get().dirHandle, fileName: opened.name });
          get().loadText(opened.text);
        }
        resolve();
      };
      input.oncancel = () => resolve();
      input.click();
    });
  },

  async save() {
    const { fileHandle, text, fileName } = get();
    if (fileHandle) {
      const granted = await ensureWritePermission(fileHandle, true);
      if (!granted) {
        set({ fileReconnectNeeded: true, saveError: 'Reconnect your file to save to disk.' });
        return;
      }
      try {
        await writeHandle(fileHandle, text);
        set({ dirty: false, fileReconnectNeeded: false });
      } catch (err) {
        set({ saveError: `Couldn't save to your file — ${errMsg(err)}` });
      }
      return;
    }
    saveLocal(text, fileName);
    downloadText(fileName ?? 'work.rune', text);
  },

  async openFolder() {
    if (!supportsDirectoryAccess()) {
      // No directory API (Firefox/Safari) — fall back to opening a single file.
      await get().openFile();
      return;
    }
    const opened = await openDirectory();
    if (!opened) return;
    if (opened.text !== null) get().loadText(opened.text);
    set({
      dirHandle: opened.dirHandle,
      fileHandle: opened.fileHandle,
      fileName: opened.name,
      dirty: false,
      fileReconnectNeeded: false,
    });
    void saveHandles({
      fileHandle: opened.fileHandle,
      dirHandle: opened.dirHandle,
      fileName: opened.name,
    });
    // A freshly created todo.rune starts empty — write the current text into it.
    if (opened.text === null) await get().save();
  },

  async attachFile(id, file) {
    const dir = get().dirHandle;
    if (dir && supportsDirectoryAccess()) {
      try {
        const rel = await writeAttachment(dir, file);
        get().addAttachment(id, file.name, rel);
        return;
      } catch {
        // Any write error -> fall back to a reference-only attachment below.
      }
    }
    get().addAttachment(id, file.name, `attachments/${file.name}`);
  },

  async openAttachment(target) {
    if (/^(https?:|mailto:)/i.test(target)) {
      window.open(target, '_blank', 'noopener,noreferrer');
      return;
    }
    const dir = get().dirHandle;
    if (!dir) return; // reference-only: nothing to open (the UI shows a location hint)
    const file = await readAttachment(dir, target);
    if (!file) return;
    const url = URL.createObjectURL(file);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },

  addFromInput(input, opts) {
    const capture = parseInput(input.trim());
    if (!capture.title && capture.tags.length === 0 && capture.contexts.length === 0 &&
        capture.priority === 0 && Object.keys(capture.keys).length === 0 &&
        capture.links.length === 0) {
      return null; // nothing meaningful to add
    }

    const line = lineFromCapture(capture);
    const parsed = parse(line);
    const taskNode = parsed.nodes.find((n): n is TaskNode => n.type === 'task');
    if (!taskNode) return null;

    const doc = get().doc;
    const id = uniqueId(existingIds(doc));
    taskNode.id = id;
    taskNode.indent = 0;
    taskNode.depth = 0;

    const newNodes: Node[] = [...doc.nodes, taskNode];

    // A //notes description becomes a `> ` child note directly under the task.
    if (capture.note) {
      newNodes.push({ type: 'note', raw: `  > ${capture.note}`, indent: 2 });
    }

    const nextDoc: Doc = { nodes: newNodes };
    commit(nextDoc, set, get);
    if (opts?.open) set({ selectedId: id, selectedIds: [id], anchorId: id });
    return id;
  },

  toggle(id) {
    const doc = get().doc;
    const idx = nodeIndexById(doc, id);
    if (idx === -1) return;
    const nowDone = (doc.nodes[idx] as TaskNode).state !== 'done';
    // Spawn the next occurrence only on a real transition INTO done (setStateDoc
    // handles the done-stamp + recurrence spawn).
    commit(setStateDoc(doc, id, nowDone ? 'done' : 'open'), set, get);
  },

  setState(id, state) {
    commit(setStateDoc(get().doc, id, state), set, get);
  },

  moveToColumn(id, col) {
    if (!isColKey(col)) return;
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    // Set the col: token (add if absent, replace in place otherwise) and then
    // the mirrored state, over the SAME doc, and commit once. skipIfEqual makes a
    // move onto the card's current column a no-op (no phantom undo / sync push).
    const withCol = replaceBody(doc, id, rebuildBody(task, { keys: { col } }));
    commit(setStateDoc(withCol, id, stateForColumn(col)), set, get);
  },

  indent(id) {
    reindent(id, +2, set, get);
  },

  outdent(id) {
    reindent(id, -2, set, get);
  },

  move(id, dir) {
    const doc = get().doc;
    if (!findById(doc, id)) return;
    // Reorder the WHOLE block: the task carries its sub-tasks/notes/comments past
    // the adjacent sibling block at the same indent. A no-op at the ends of the
    // sibling run (moveBlock returns an equivalent doc) is dropped by commit's
    // default skipIfEqual, so no phantom undo entry is pushed.
    commit(moveBlock(doc, id, dir), set, get);
  },

  moveTo(sourceId, targetId, place) {
    const doc = get().doc;
    if (!findById(doc, sourceId) || !findById(doc, targetId)) return;
    // moveBlockTo is sibling-scoped and returns an equivalent doc for an invalid
    // or no-op drop; commit's skipIfEqual then avoids a phantom undo entry.
    commit(moveBlockTo(doc, sourceId, targetId, place), set, get);
  },

  setText(text, opts) {
    commit(text, set, get, opts);
  },

  // --- editing actions ------------------------------------------------------

  remove(id) {
    const doc = get().doc;
    if (!findById(doc, id)) return;
    commit(removeTask(doc, id), set, get);
    // Prune selection when the selected row (or a swept-along descendant) is gone.
    pruneSelection(get, set);
  },

  removeMany(ids) {
    let next = get().doc;
    let changed = false;
    // Fold removeTask over the EVOLVING doc: each call re-resolves the id to a
    // fresh index, so order is irrelevant and removing a parent before one of its
    // now-gone descendants is a harmless skip. One commit for the whole batch.
    for (const id of ids) {
      if (!findById(next, id)) continue;
      next = removeTask(next, id);
      changed = true;
    }
    if (!changed) return;
    commit(next, set, get);
    pruneSelection(get, set);
  },

  removeTaskWithTicket(id) {
    const doc = get().doc;
    const idx = nodeIndexById(doc, id);
    if (idx === -1) return null;
    const end = descendantEndIndex(doc, idx);
    const block = serialize({ nodes: doc.nodes.slice(idx, end) });
    // Anchor to the nearest preceding TASK (the only node kind with a stable id).
    // null => the block was at the top of the document.
    let afterId: string | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      const n = doc.nodes[i];
      if (n.type === 'task' && n.id) {
        afterId = n.id;
        break;
      }
    }
    commit(removeTask(doc, id), set, get);
    pruneSelection(get, set);
    return { block, afterId };
  },

  restoreDeleted(ticket) {
    const next = insertBlockDoc(get().doc, ticket);
    if (next === get().doc) return;
    commit(next, set, get);
  },

  removeManyWithTicket(ids) {
    const doc = get().doc;
    // Order ids by original document position so the captured tickets restore in
    // order (an earlier block can be a later block's anchor).
    const ordered = Array.from(new Set(ids))
      .map((id) => ({ id, idx: nodeIndexById(doc, id) }))
      .filter((x) => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx)
      .map((x) => x.id);
    if (ordered.length === 0) return null;

    // Capture each block + anchor from the ORIGINAL doc (indices are stable
    // here). An id INSIDE an earlier-captured block (a descendant of another
    // deleted task) is skipped — its lines are already in that ticket, and a
    // second ticket would duplicate them on restore.
    const tickets: DeleteTicket[] = [];
    let coveredUntil = -1;
    for (const id of ordered) {
      const idx = nodeIndexById(doc, id);
      if (idx === -1 || idx < coveredUntil) continue;
      const end = descendantEndIndex(doc, idx);
      coveredUntil = end;
      const block = serialize({ nodes: doc.nodes.slice(idx, end) });
      let afterId: string | null = null;
      for (let i = idx - 1; i >= 0; i--) {
        const n = doc.nodes[i];
        if (n.type === 'task' && n.id) {
          afterId = n.id;
          break;
        }
      }
      tickets.push({ block, afterId });
    }

    // Remove all in one commit (fold over the evolving doc; a parent removed
    // before one of its now-gone descendants is a harmless skip).
    let next = doc;
    for (const id of ordered) {
      if (findById(next, id)) next = removeTask(next, id);
    }
    commit(next, set, get);
    pruneSelection(get, set);
    return { tickets };
  },

  restoreDeletedMany(bulk) {
    let next = get().doc;
    for (const ticket of bulk.tickets) next = insertBlockDoc(next, ticket);
    if (next === get().doc) return;
    commit(next, set, get);
  },

  setBody(id, body) {
    const doc = get().doc;
    if (!findById(doc, id)) return;
    commit(replaceBody(doc, id, body), set, get);
  },

  addChild(parentId, input) {
    const doc = get().doc;
    if (!findById(doc, parentId)) return null;
    const body = input !== undefined ? canonicalBody(input) : '';
    const id = uniqueId(existingIds(doc));
    const line = `- [ ] ${body ? body + ' ' : ''}^${id}`;
    commit(insertChild(doc, parentId, line), set, get);
    return id;
  },

  addSibling(afterId, input) {
    const doc = get().doc;
    if (!findById(doc, afterId)) return null;
    const body = input !== undefined ? canonicalBody(input) : '';
    const id = uniqueId(existingIds(doc));
    const line = `- [ ] ${body ? body + ' ' : ''}^${id}`;
    commit(insertSibling(doc, afterId, line), set, get);
    return id;
  },

  setPriority(id, level) {
    commit(setPriorityDoc(get().doc, id, level), set, get);
  },

  setDue(id, dateInput) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return false;
    const trimmed = dateInput.trim();
    let value: string | null;
    if (trimmed === '') {
      value = null; // clear
    } else {
      // Accept a stored ISO directly, else parse natural language to ISO.
      value = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? trimmed
        : parseDateStrict(trimmed);
      if (value === null) return false; // unparseable date -> no change, signal it
    }
    const body = rebuildBody(task, { keys: { due: value } });
    commit(replaceBody(doc, id, body), set, get);
    return true;
  },

  toggleTag(id, tag) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    const clean = slugToken(tag.replace(/^#/, ''));
    if (!clean) return;
    const has = task.segments.some((s) => s.kind === 'tag' && s.value === clean);
    const body = rebuildBody(task, has ? { removeTag: clean } : { addTag: clean });
    commit(replaceBody(doc, id, body), set, get);
  },

  setAfter(id, deps) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    const clean = deps.map((d) => d.replace(/^\^/, '').trim()).filter(Boolean);
    const value = clean.length > 0 ? clean.join(',') : null;
    const body = rebuildBody(task, { keys: { after: value } });
    commit(replaceBody(doc, id, body), set, get);
  },

  rename(id, title) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    const body = rebuildBody(task, { title: title.trim() });
    commit(replaceBody(doc, id, body), set, get);
  },

  addAttachment(id, label, target) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    const cleanTarget = target.trim();
    if (!cleanTarget) return;
    // Idempotent: don't append a duplicate. Stored targets are the ENCODED form,
    // and `target` here is RAW (from a dropped file/URL), so compare encoded.
    const storedTarget = encodeLinkTarget(cleanTarget);
    if (attachmentsOf(task).some((a) => a.target === storedTarget)) return;
    const link = markdownLink(label.trim() || cleanTarget, cleanTarget);
    const body = canonicalBodyOf(task);
    const next = body ? `${body} ${link}` : link;
    commit(replaceBody(doc, id, next), set, get);
  },

  removeAttachment(id, target) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    const cleanTarget = target.trim();
    // Stored targets are encoded; callers may pass either the raw or the stored
    // (encoded) form, so match against both.
    const encoded = encodeLinkTarget(cleanTarget);
    const body = task.segments
      .filter(
        (s) =>
          !(s.kind === 'link' && (s.target === cleanTarget || s.target === encoded)),
      )
      .map((s) => s.raw)
      .join(' ')
      .trim();
    commit(replaceBody(doc, id, body), set, get);
  },

  // --- Wave 5 editing actions -----------------------------------------------

  toggleContext(id, ctx) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    const clean = slugToken(ctx.replace(/^@/, ''));
    if (!clean) return;
    const has = task.segments.some((s) => s.kind === 'context' && s.value === clean);
    const body = has
      ? rebuildBody(task, { removeContext: clean })
      : rebuildBody(task, { addContext: clean });
    commit(replaceBody(doc, id, body), set, get);
  },

  setScheduled(id, dateInput) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    const trimmed = dateInput.trim();
    let value: string | null;
    if (trimmed === '') {
      value = null; // clear
    } else {
      // Accept a stored ISO directly, else parse natural language to ISO — the
      // same path setDue uses.
      value = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? trimmed
        : parseDateStrict(trimmed);
      if (value === null) return; // unparseable date -> no change
    }
    // Also clear the `start:` alias so editing Scheduled never leaves an orphan
    // start: the UI keeps hiding behind scheduled and can't clear.
    const body = rebuildBody(task, { keys: { scheduled: value, start: null } });
    commit(replaceBody(doc, id, body), set, get);
  },

  setRecurrence(id, rule, rolling) {
    const doc = get().doc;
    const task = findById(doc, id);
    if (!task) return;
    const clean = rule.trim();
    // Always clear BOTH keys first (the rolling flag may have flipped), then set
    // the one we want. rebuildBody quotes the value when it has spaces.
    const keys: Record<string, string | null> = { recur: null, 'recur!': null };
    if (clean) keys[rolling ? 'recur!' : 'recur'] = clean;
    const body = rebuildBody(task, { keys });
    commit(replaceBody(doc, id, body), set, get);
  },

  setAuthor(name) {
    const clean = name.trim();
    if (clean) set({ author: clean });
  },

  addComment(itemId, body) {
    const doc = get().doc;
    if (!findById(doc, itemId)) return;
    if (!body.trim()) return; // no-op on empty
    const commentId = nextCommentId(doc);
    const next = insertComment(doc, itemId, { author: get().author, commentId, body });
    commit(next, set, get);
  },

  replyToComment(itemId, parentCommentId, body) {
    const doc = get().doc;
    if (!findById(doc, itemId)) return;
    if (!body.trim()) return; // no-op on empty
    const commentId = nextCommentId(doc);
    const next = insertComment(doc, itemId, {
      author: get().author,
      commentId,
      reply: parentCommentId,
      body,
    });
    commit(next, set, get);
  },

  resolveComment(commentId, resolved) {
    const doc = get().doc;
    // A no-op (unknown/inline comment, or already in the target state) is dropped
    // by commit's default skipIfEqual — no phantom undo entry.
    commit(setCommentResolved(doc, commentId, resolved), set, get);
  },

  undo() {
    // An undo boundary ends any in-progress coalescing burst.
    lastCoalesceKey = null;
    const { undoStack, redoStack, text } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    const nextUndo = undoStack.slice(0, -1);
    const nextRedo = [...redoStack, text];
    const doc = parse(prev);
    set({
      text: prev,
      doc,
      undoStack: nextUndo,
      redoStack: nextRedo,
      canUndo: nextUndo.length > 0,
      canRedo: true,
    });
    persistAfterChange(prev, get, set);
  },

  redo() {
    lastCoalesceKey = null;
    const { undoStack, redoStack, text } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    const nextRedo = redoStack.slice(0, -1);
    const nextUndo = [...undoStack, text];
    const doc = parse(next);
    set({
      text: next,
      doc,
      undoStack: nextUndo,
      redoStack: nextRedo,
      canUndo: true,
      canRedo: nextRedo.length > 0,
    });
    persistAfterChange(next, get, set);
  },

  // --- cross-device sync actions --------------------------------------------

  setSyncToken(token) {
    const clean = token.trim();
    const value = clean || null;
    set({ syncToken: value });
    lsSet(SYNC_TOKEN_KEY, value);
  },

  async enableSync(on) {
    if (!on) {
      // Disable: cancel any pending push, persist the flag, go quiet. The token
      // is kept so re-enabling later doesn't require re-pasting it. Record an
      // explicit opt-out so a trusted-network server is never auto-re-enabled on
      // this device — an explicit "off" must stick across reloads.
      if (syncPushTimer) {
        clearTimeout(syncPushTimer);
        syncPushTimer = null;
      }
      set({
        syncEnabled: false,
        syncStatus: 'off',
        syncError: null,
        syncConflict: false,
        conflictText: null,
        conflictUpdatedAt: null,
      });
      lsSet(SYNC_ENABLED_KEY, null);
      lsSet(SYNC_OPTOUT_KEY, '1');
      return;
    }

    // A manual enable needs a token UNLESS the server is a known open
    // (token-less) one — there an empty token is exactly right.
    const stored = get().syncToken;
    if (stored === null && !get().syncOpen) {
      set({ syncStatus: 'error', syncError: 'Paste a sync token first.' });
      return;
    }
    const token = stored ?? '';

    // Turn on and persist immediately so a reload stays enabled; clear any prior
    // opt-out (the user just said yes).
    set({ syncEnabled: true, syncToken: token, syncStatus: 'syncing', syncError: null });
    lsSet(SYNC_ENABLED_KEY, '1');
    lsSet(SYNC_TOKEN_KEY, token);
    lsSet(SYNC_OPTOUT_KEY, null);

    const before = get().text;
    try {
      const remote = await pullDoc(token);
      // Race guard: an edit landed while the pull was in flight — never discard
      // it. If it now differs from the server, keep local and flag a conflict.
      const editedDuringPull = get().text !== before;

      if (remote) {
        if (editedDuringPull && remote.text !== get().text) {
          setLastSynced(remote.updatedAt, set);
          set({
            syncConflict: true,
            conflictText: remote.text,
            conflictUpdatedAt: remote.updatedAt,
            syncDirty: true,
            syncStatus: 'synced',
            syncLastAt: remote.updatedAt || new Date().toISOString(),
            syncError: null,
          });
          lsSet(SYNC_DIRTY_KEY, '1');
        } else {
          // NON-EMPTY server doc: adopt the synced list (the dialog warned the
          // user this replaces local).
          get().loadText(remote.text);
          setLastSynced(remote.updatedAt, set);
          set({
            syncDirty: false,
            syncStatus: 'synced',
            syncLastAt: remote.updatedAt || new Date().toISOString(),
            syncError: null,
          });
          lsSet(SYNC_DIRTY_KEY, null);
        }
      } else if (isPristine(get)) {
        // EMPTY server + pristine local (onboarding seed): stay quiet. Never seed
        // a shared server with the onboarding doc — it must stay empty until this
        // (or another) device has real content.
        set({
          syncDirty: false,
          syncStatus: 'synced',
          syncLastAt: new Date().toISOString(),
          syncError: null,
        });
        lsSet(SYNC_DIRTY_KEY, null);
      } else {
        // EMPTY server doc: seed it with this device's real text under an
        // expect-empty precondition — if another device seeded it between our pull
        // and push, surface a conflict rather than clobber.
        const res = await pushDoc(token, get().text, { expectEmpty: true });
        if (res.conflict) {
          set({
            syncConflict: true,
            conflictText: res.text ?? '',
            conflictUpdatedAt: res.updatedAt,
            syncDirty: true,
            syncStatus: 'synced',
            syncLastAt: new Date().toISOString(),
            syncError: null,
          });
          lsSet(SYNC_DIRTY_KEY, '1');
        } else {
          setLastSynced(res.updatedAt, set);
          set({
            syncDirty: false,
            syncStatus: 'synced',
            syncLastAt: new Date().toISOString(),
            syncError: null,
          });
          lsSet(SYNC_DIRTY_KEY, null);
        }
      }
    } catch (err) {
      // A sync failure must never throw into the app; surface it as a status.
      // Keep sync ENABLED (the flag is persisted) so a later "Sync now"/retry can
      // recover once the token/network is fixed.
      set({ syncStatus: 'error', syncError: errMsg(err) });
    }
  },

  async syncNow() {
    const { syncEnabled, syncToken } = get();
    if (!syncEnabled || syncToken === null) return;
    if (syncPushTimer) {
      clearTimeout(syncPushTimer);
      syncPushTimer = null;
    }
    // Conflict blocks pushes until resolved (doPush no-ops while syncConflict is
    // set) — the dialog's Reload / Keep-mine drive resolution, not a blind retry.
    await doPush(get, set);
  },

  reloadFromSync() {
    const { conflictText, conflictUpdatedAt } = get();
    if (conflictText === null) return;
    get().loadText(conflictText);
    setLastSynced(conflictUpdatedAt ?? '', set);
    set({
      syncConflict: false,
      conflictText: null,
      conflictUpdatedAt: null,
      syncDirty: false,
      syncStatus: 'synced',
      syncLastAt: new Date().toISOString(),
      syncError: null,
    });
    lsSet(SYNC_DIRTY_KEY, null);
  },

  dismissConflict() {
    // "Keep mine": the ONLY sanctioned overwrite of a DIFFERING server doc, and it
    // is explicit (the user clicked Keep-mine). Clear the conflict and FORCE-push
    // local over the server — an unconditional PUT, the one place that is allowed.
    // (Semantics settled: Keep-mine actively overwrites the server; it does not
    // merely hide the banner and leave local silently dirty.)
    if (!get().syncConflict) return;
    if (syncPushTimer) {
      clearTimeout(syncPushTimer);
      syncPushTimer = null;
    }
    set({
      syncConflict: false,
      conflictText: null,
      conflictUpdatedAt: null,
      syncDirty: true,
    });
    lsSet(SYNC_DIRTY_KEY, '1');
    void doPush(get, set, { force: true });
  },

  async reconnectFile() {
    const handle = get().fileHandle ?? get().dirHandle;
    if (!handle) return;
    const granted = await ensureWritePermission(handle, true);
    if (!granted) {
      set({ saveError: "Couldn't get permission to write your file." });
      return;
    }
    set({ fileReconnectNeeded: false });
    const fileHandle = get().fileHandle;
    if (fileHandle) {
      const text = get().text;
      try {
        await writeHandle(fileHandle, text);
        if (get().text === text) set({ dirty: false });
      } catch (err) {
        set({ saveError: `Couldn't save to your file — ${errMsg(err)}` });
      }
    }
  },

  ackSaveError() {
    set({ saveError: null });
  },

  select(id) {
    // A plain selection collapses any multi-selection and re-anchors here.
    set({ selectedId: id, selectedIds: id ? [id] : [], anchorId: id });
  },

  selectRange(leadId, visibleIds) {
    const anchor = get().anchorId ?? get().selectedId ?? leadId;
    const ai = visibleIds.indexOf(anchor);
    const li = visibleIds.indexOf(leadId);
    if (ai === -1 || li === -1) {
      // Anchor/lead not on screen — fall back to a single selection.
      set({ selectedId: leadId, selectedIds: [leadId], anchorId: anchor });
      return;
    }
    const [lo, hi] = ai <= li ? [ai, li] : [li, ai];
    set({ selectedId: leadId, selectedIds: visibleIds.slice(lo, hi + 1), anchorId: anchor });
  },

  toggleSelect(id) {
    if (!id) return;
    const cur = get().selectedIds;
    if (cur.includes(id)) {
      const next = cur.filter((x) => x !== id);
      const lead = next.length ? next[next.length - 1] : null;
      set({
        selectedIds: next,
        selectedId: lead,
        anchorId: lead,
        // Deselecting the last row leaves touch select mode.
        selectMode: next.length ? get().selectMode : false,
      });
    } else {
      set({ selectedIds: [...cur, id], selectedId: id, anchorId: id });
    }
  },

  clearSelection() {
    set({ selectedId: null, selectedIds: [], anchorId: null, selectMode: false });
  },

  enterSelectMode(id) {
    const cur = get().selectedIds;
    if (id && !cur.includes(id)) {
      set({ selectMode: true, selectedIds: [...cur, id], selectedId: id, anchorId: id });
    } else {
      set({ selectMode: true });
    }
  },

  // --- bulk verbs (one commit each) ----------------------------------------

  toggleManyDone(ids) {
    const doc = get().doc;
    const present = ids.filter((id) => findById(doc, id));
    if (present.length === 0) return;
    const allDone = present.every((id) => (findById(doc, id) as TaskNode).state === 'done');
    const target: State = allDone ? 'open' : 'done';
    bulkCommit(present, (d, id) => setStateDoc(d, id, target), set, get);
  },

  setStateMany(ids, state) {
    bulkCommit(ids, (d, id) => setStateDoc(d, id, state), set, get);
  },

  setPriorityMany(ids, level) {
    bulkCommit(ids, (d, id) => setPriorityDoc(d, id, level), set, get);
  },

  addTagMany(ids, tag) {
    bulkCommit(ids, (d, id) => addTagDoc(d, id, tag), set, get);
  },

  setDueMany(ids, dateInput) {
    const trimmed = dateInput.trim();
    let value: string | null;
    if (trimmed === '') {
      value = null; // clear
    } else {
      // Parse ONCE (ISO passes through, else natural language -> ISO); a
      // near-miss leaves every task untouched and signals the caller.
      value = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : parseDateStrict(trimmed);
      if (value === null) return false;
    }
    bulkCommit(
      ids,
      (d, id) => {
        const task = findById(d, id);
        return task ? replaceBody(d, id, rebuildBody(task, { keys: { due: value } })) : d;
      },
      set,
      get,
    );
    return true;
  },

  indentMany(ids) {
    bulkCommit(ids, (d, id) => reindentDoc(d, id, +2), set, get);
  },

  outdentMany(ids) {
    bulkCommit(ids, (d, id) => reindentDoc(d, id, -2), set, get);
  },

  setHideDone(on) {
    lsSet('rune:hidedone', on ? '1' : '0');
    set({ hideDone: on });
  },

  setTheme(t) {
    set({ theme: t });
    lsSet(THEME_KEY, t);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', t);
    }
  },
}));

// --- TaskNode editing helpers (pure-ish; return fresh nodes) -----------------

function withState(t: TaskNode, state: State): TaskNode {
  return { ...t, state, stateChar: STATE_CHAR[state], segments: t.segments.map((s) => ({ ...s })) };
}

/** Stamp `done:<iso>` as a key segment (idempotent — replaces an existing one). */
function stampDone(t: TaskNode, iso: string): void {
  const existing = t.segments.find((s) => s.kind === 'key' && s.key === 'done');
  if (existing) {
    existing.value = iso;
    existing.raw = `done:${iso}`;
    return;
  }
  t.segments.push({ kind: 'key', raw: `done:${iso}`, key: 'done', value: iso });
}

function clearDone(t: TaskNode): void {
  t.segments = t.segments.filter((s) => !(s.kind === 'key' && s.key === 'done'));
}

/** The recurrence key segment (`recur` or `recur!`) of a task, or null. */
function recurSegment(t: TaskNode): Segment | null {
  return (
    t.segments.find(
      (s) => s.kind === 'key' && (s.key === 'recur' || s.key === 'recur!'),
    ) ?? null
  );
}

/** The date key a recurrence is anchored to: scheduled: first, else due:. */
function anchorDateSegment(t: TaskNode): Segment | undefined {
  return (
    t.segments.find((s) => s.kind === 'key' && s.key === 'scheduled') ??
    t.segments.find((s) => s.kind === 'key' && s.key === 'due')
  );
}

/**
 * Build the next OPEN occurrence of a just-completed recurring task, or null if
 * it does not recur / the rule or anchor doesn't resolve. Cadence semantics:
 *   recur:  anchored to the task's own scheduled:/due: date (fixed plan).
 *   recur!: anchored to TODAY's completion date (rolling).
 */
function spawnRecurrence(completed: TaskNode, takenInIds: Node[]): TaskNode | null {
  const recur = recurSegment(completed);
  if (!recur || !recur.value) return null;
  const rolling = recur.key === 'recur!';

  const anchorSeg = anchorDateSegment(completed);
  // recur: needs a stored date to anchor to; recur! rolls from completion today.
  const fromISO = rolling ? toISO(new Date()) : anchorSeg?.value;
  if (!fromISO) return null;

  const nextISO = nextOccurrence(recur.value, fromISO);
  if (!nextISO) return null;

  // Clone the completed task as a fresh OPEN copy: reset state, drop any done:
  // stamp, advance the anchor date, and mint a new id.
  const copy: TaskNode = withState(completed, 'open');
  clearDone(copy);

  // Roll the anchor date forward in place. For recur! with no stored date, add a
  // scheduled: segment so the new occurrence carries its next date.
  const copyAnchor =
    copy.segments.find(
      (s) => s.kind === 'key' && (s.key === 'scheduled' || s.key === 'due'),
    ) ?? null;
  if (copyAnchor) {
    copyAnchor.value = nextISO;
    copyAnchor.raw = `${copyAnchor.key}:${nextISO}`;
  } else {
    copy.segments.push({ kind: 'key', raw: `scheduled:${nextISO}`, key: 'scheduled', value: nextISO });
  }

  const taken = takenInIds
    .filter((n): n is TaskNode => n.type === 'task')
    .map((t) => t.id)
    .filter((x): x is string => x !== null);
  copy.id = uniqueId(taken);
  return copy;
}

/** The indent of any node (raw nodes may omit it -> treated as 0). */
function nodeIndent(node: Node): number {
  return node.type === 'task' ? node.indent : node.indent ?? 0;
}

/** Re-spell a node at a new indent. Tasks carry indent/depth and let serialize
 *  re-emit the prefix; raw nodes (note/comment/heading) get their leading
 *  whitespace rewritten so serialize (which prints their raw verbatim) reflects
 *  the shift. Blank lines have no meaningful indent — left untouched. */
function withIndent(node: Node, indent: number): Node {
  if (node.type === 'task') {
    return { ...node, indent, depth: Math.floor(indent / 2) };
  }
  if (node.type === 'blank') return node;
  return { ...node, indent, raw: node.raw.replace(/^\s*/, ' '.repeat(indent)) };
}

/**
 * Tab / Shift-Tab reindent. Shifts the task AND its whole descendant block by
 * `delta` (each node ±one level), mirroring moveBlock — a parent never leaves its
 * children behind. Refuses to move when the parent would cross indent 0 (which
 * would squash the block's relative structure); commit's skipIfEqual then also
 * drops the resulting no-op cleanly.
 */
function reindent(id: string, delta: number, set: SetFn, get: GetFn): void {
  commit(reindentDoc(get().doc, id, delta), set, get);
}

/** PURE `Doc -> Doc` reindent of a task + its whole descendant block by `delta`
 *  (mirrors {@link reindent}). Returns the SAME doc reference when it would be a
 *  no-op (unknown id / block would cross column 0), so a fold can detect "no
 *  change" and skipIfEqual drops it. */
function reindentDoc(doc: Doc, id: string, delta: number): Doc {
  const idx = nodeIndexById(doc, id);
  if (idx === -1) return doc;
  const node = doc.nodes[idx] as TaskNode;
  if (node.indent + delta < 0) return doc; // can't outdent the block past column 0

  const end = descendantEndIndex(doc, idx);
  const nodes = doc.nodes.slice();
  for (let i = idx; i < end; i++) {
    nodes[i] = withIndent(nodes[i], Math.max(0, nodeIndent(nodes[i]) + delta));
  }
  return { nodes };
}

/** PURE `Doc -> Doc` state change of a task, with the done-stamp and — on a real
 *  transition INTO done — the next recurrence occurrence spawned after the task's
 *  whole block (mirrors the old replaceNode). Returns the SAME doc reference for
 *  an unknown id. */
function setStateDoc(doc: Doc, id: string, state: State): Doc {
  const idx = nodeIndexById(doc, id);
  if (idx === -1) return doc;
  const node = doc.nodes[idx] as TaskNode;
  const wasDone = node.state === 'done';
  const next = withState(node, state);
  if (state === 'done') stampDone(next, toISO(new Date()));
  else clearDone(next);
  const nodes = doc.nodes.slice();
  nodes[idx] = next;
  const spawned = state === 'done' && !wasDone ? spawnRecurrence(node, nodes) : null;
  if (spawned) nodes.splice(descendantEndIndex({ nodes }, idx), 0, spawned);
  return { nodes };
}

/** PURE `Doc -> Doc` priority set (0 clears, 1..3 sets the `!`-count). */
function setPriorityDoc(doc: Doc, id: string, level: number): Doc {
  const task = findById(doc, id);
  if (!task) return doc;
  const clamped = Math.max(0, Math.min(3, Math.floor(level)));
  const body = rebuildBody(task, { priority: clamped > 0 ? '!'.repeat(clamped) : null });
  return replaceBody(doc, id, body);
}

/** PURE `Doc -> Doc` tag ADD (no-op — same doc ref — when the tag is already
 *  present or the token is empty). */
function addTagDoc(doc: Doc, id: string, tag: string): Doc {
  const task = findById(doc, id);
  if (!task) return doc;
  const clean = slugToken(tag.replace(/^#/, ''));
  if (!clean) return doc;
  if (task.segments.some((s) => s.kind === 'tag' && s.value === clean)) return doc;
  return replaceBody(doc, id, rebuildBody(task, { addTag: clean }));
}

/** PURE core of restoreDeleted: re-insert a captured block, anchored after its
 *  original predecessor when that still exists, else appended at the end. Returns
 *  the SAME doc reference when the block parses empty. */
function insertBlockDoc(doc: Doc, ticket: DeleteTicket): Doc {
  const blockNodes = parse(ticket.block).nodes;
  if (blockNodes.length === 0) return doc;
  const blockIndent = blockNodes[0].type === 'task' ? blockNodes[0].indent : 0;

  let at: number;
  if (ticket.afterId === null) {
    at = 0; // was at the top of the document
  } else {
    const aIdx = nodeIndexById(doc, ticket.afterId);
    if (aIdx === -1) {
      at = doc.nodes.length; // anchor gone -> append at the end
    } else {
      const aIndent = (doc.nodes[aIdx] as TaskNode).indent;
      // A shallower anchor is the block's PARENT: re-insert as its first child
      // (right after it). A same/deeper anchor is a preceding sibling/cousin:
      // re-insert after its whole descendant block.
      at = aIndent < blockIndent ? aIdx + 1 : descendantEndIndex(doc, aIdx);
    }
  }
  const nodes = doc.nodes.slice();
  nodes.splice(at, 0, ...blockNodes);
  return { nodes };
}

/** Fold a pure `Doc -> Doc` transform over a set of ids and commit ONCE (a
 *  single undo step). A transform returning the same doc reference is a skip; a
 *  fully no-op batch commits nothing. */
function bulkCommit(
  ids: string[],
  transform: (doc: Doc, id: string) => Doc,
  set: SetFn,
  get: GetFn,
): void {
  let next = get().doc;
  let changed = false;
  for (const id of ids) {
    const after = transform(next, id);
    if (after !== next) {
      next = after;
      changed = true;
    }
  }
  if (changed) commit(next, set, get);
}
