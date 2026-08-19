# Rune — Wave 2 Contracts

This document is the **binding interface** between the foundation (this wave) and
the parallel fan-out of Wave 2 agents. The foundation is a coherent backbone:
the store, the design tokens, the `@core` alias, and the stub signatures below
are **locked**. Wave 2 agents fill in stub bodies and build views/components
**against these contracts** so parallel work cannot conflict.

## 0. The one rule that prevents conflicts

**Each Wave 2 agent edits ONLY its owned files.** No agent edits `web/App.tsx`,
`web/store/store.ts`, `web/main.tsx`, `web/design/tokens.css`, `web/app.css`, or
another agent's files. If you need a new store action, a new token, or a new
route, that is a foundation change — request it; do not add it yourself. New
behavior goes inside the file you own (e.g. the Cmd+K action set lives entirely
inside `CommandPalette.tsx`).

Anything under `src/` that is M0 (`parse.ts`, `scan.ts`, `serialize.ts`,
`types.ts`, `index.ts`) and all of `test/` are **frozen**. The M0 tests must
keep passing.

## 1. The `@core` import alias

The M0 parser/serializer is consumed through one alias — never by relative path:

```ts
import type { Doc, TaskNode, Node, Segment, State } from '@core';
import { parse, serialize, tasks, findById, titleOf, tagsOf, contextsOf,
         priorityOf, getKey, afterOf, refsOf, attachmentsOf } from '@core';
```

- `@core`  -> `src/index.ts` (the M0 barrel; types + helpers).
- `@core/*` -> `src/*` (for the new stub modules: `@core/recur`,
  `@core/criticmarkup`, `@core/reconcile`).

Configured in `vite.config.ts` (alias) and `tsconfig.json` (`paths`). **The
`.rune` text is canonical.** The app does: `parse(text) -> mutate Doc ->
serialize(doc) -> autosave`. Never invent a second representation.

## 2. Store API (LOCKED) — `web/store/store.ts`

Use the hook `useStore` (zustand). Selectors: `useStore(s => s.doc)` etc. Outside
React: `useStore.getState()`.

### State

| Field | Type | Meaning |
|---|---|---|
| `text` | `string` | canonical `.rune` bytes (always `serialize(doc)`) |
| `doc` | `Doc` | parsed view of `text` (from `@core`) |
| `selectedId` | `string \| null` | the selected task's `^id` |
| `theme` | `'dark' \| 'light'` | active theme (also mirrored to `<html data-theme>`) |
| `fileName` | `string \| null` | open file's name |
| `fileHandle` | `FsFileHandle \| null` | live File System Access handle when present |

### Actions (exact final signatures)

```ts
loadText(text: string): void
init(): Promise<void>                 // localStorage -> seed /work.rune -> empty
openFile(): Promise<void>             // FS Access API; falls back to <input type=file>
save(): Promise<void>                 // write via handle, else localStorage + download
addFromInput(input: string, opts?: { open?: boolean }): string | null
toggle(id: string): void             // open<->done; stamps/clears done:<ISO>
setState(id: string, state: State): void
indent(id: string): void
outdent(id: string): void
move(id: string, dir: 'up' | 'down'): void
setText(text: string): void          // raw edit -> reparse (undoable)
select(id: string | null): void
setTheme(t: 'dark' | 'light'): void

// --- editing layer (added this wave) ---
remove(id: string): void                          // delete the line + descendant block
setBody(id: string, body: string): void           // replace body after `- [state] `
addChild(parentId: string, input?: string): string | null   // sub-task; '' => empty `- [ ]`
addSibling(afterId: string, input?: string): string | null
setPriority(id: string, level: number): void      // 0 clears, 1..3 sets the !-count
setDue(id: string, dateInput: string): void       // NL/ISO -> due:; '' clears
toggleTag(id: string, tag: string): void          // add/remove a #tag (no leading #)
setAfter(id: string, deps: string[]): void        // set/replace after: csv; [] clears
rename(id: string, title: string): void           // replace leading title words only

// --- attachments (added Wave 4) ---
addAttachment(id: string, label: string, target: string): void   // append [label](target)
removeAttachment(id: string, target: string): void               // drop link seg whose target matches

undo(): void
redo(): void
```

### Editing state (added this wave)

| Field | Type | Meaning |
|---|---|---|
| `undoStack` | `string[]` | prior `text` snapshots, oldest first (bounded ~100) |
| `redoStack` | `string[]` | undone `text` snapshots, most-recent last |
| `canUndo` | `boolean` | true when an undo step is available |
| `canRedo` | `boolean` | true when a redo step is available |

**Invariant:** every mutation re-runs `serialize(doc)` into `text` and autosaves
to `localStorage["rune:doc"]`. All mutating actions (toggle/setState/indent/
outdent/move/addFromInput/setText + the editing actions above) route through a
single internal `commit(nextDoc | nextText)` helper that pushes the previous
`text` onto the bounded undo stack (clearing redo) before updating + autosaving —
so undo/redo works uniformly across every edit. `loadText` (open file / init)
clears the history (a fresh document is a fresh editing context). `addFromInput`
parses via `capture.parseInput`, builds a canonical `- [ ] <body>` line, parses
it with `@core`, stamps a fresh `^t-` id (base36, via `lib/ids`), appends at
depth 0, and returns the new id (or `null` if the input was empty). A `//notes`
description is appended as a `> ` child note. `addChild`/`addSibling` likewise
run `input` through `capture.parseInput` for the canonical body, stamp a fresh
id, and place the line via `edit.insertChild`/`edit.insertSibling`. The
segment-aware setters (`setPriority`/`setDue`/`toggleTag`/`setAfter`/`rename`)
rebuild the body from the task's existing segments with one targeted change and
re-apply it through `edit.replaceBody` (which re-parses with `@core`).

> Note: `init()` is the only addition beyond the brief's listed actions — it is
> the startup loader (localStorage else `/work.rune` else empty) the brief
> describes in prose. `App.tsx` calls it once on mount.

## 3. Design tokens (LOCKED) — `web/design/tokens.css`

Reference tokens as `var(--name)`; never hard-code a value. `web/design/tokens.ts`
exports the typed names (`tokens.accent` -> `'--accent'`, `cssVar()` wraps them).

**Color (dark default; `[data-theme="light"]` is a designed sibling):**
`--canvas --surface --elevated --ink --body --mute --faint --hairline --accent
--accent-soft --danger`

**Type families:** `--font-body` (iA Writer Duo / IBM Plex Mono),
`--font-chrome` (Inter). Tabular-nums is on globally.

**Type scale tokens:** `--size-page-title --weight-page-title --lh-page-title
--track-page-title`; `--size-section --weight-section --lh-section
--track-section`; `--size-row --weight-row --lh-row`; `--size-meta --weight-meta
--lh-meta`; `--size-caption --weight-caption --lh-caption`.

**Spacing:** `--space-1`(2) … `--space-9`(96), plus `--row-pad-y` (8),
`--checkbox-gap` (12), `--section-gap` (24).

**Radius:** `--radius-row` (6), `--radius-card` (10).

**Motion:** `--ease`, `--dur-state` (120ms), `--dur-expand` (180ms),
`--dur-reflow` (200ms), `--dur-strike` (160ms). All collapse to 0 under
`prefers-reduced-motion`.

**Anti-clutter (non-negotiable):** absent metadata renders nothing; metadata is
quiet inline mute-ink text, not chips/pills; row chrome reveals on
hover/`:focus-within`; overdue = `--danger` tint on the date only, never a
badge/count; no zebra, no card borders, 1px hairlines only.

## 4. Component prop contracts (LOCKED)

```ts
// Checkbox.tsx
interface CheckboxProps { state: State; onToggle: () => void }

// Meta.tsx — renders null when the task has no metadata
interface MetaProps { task: TaskNode; now?: Date }

// Row.tsx (extended this wave with inline edit + delete)
interface RowProps {
  task: TaskNode;
  selected: boolean;
  now?: Date;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  onOpen?: (id: string) => void;
  onEdit?: (id: string) => void;                    // enter inline edit
  onDelete?: (id: string) => void;                  // hover trash / Backspace
  editing?: boolean;                                // THIS row is in inline edit
  onEditCommit?: (id: string, body: string) => void;
  onEditCancel?: () => void;
}
// Also exports editableBody(task): string — the body (all tokens, no `- [x] `
// prefix, no trailing ^id) used to pre-fill the inline editor.

// DetailCard.tsx (extracted from App this wave; editable)
interface DetailCardProps { id: string; onClose: () => void }
// Editable title (rename), due (setDue), priority (setPriority), tags
// (toggleTag), dependencies/after (setAfter); "Add sub-task" (addChild) +
// "Delete" (remove + close). Preserves the CommentGutter mount.

// QuickAdd.tsx — imperative focus() for the global `c` key
interface QuickAddHandle { focus(): void }
const QuickAdd: ForwardRefExoticComponent<RefAttributes<QuickAddHandle>>

// CommandPalette.tsx (STUB)
interface CommandPaletteProps { open: boolean; onClose: () => void }

// CommentGutter.tsx (STUB)
interface CommentGutterProps { doc: Doc; itemId: string | null }
```

Views (`DocumentView`, `TodayView`, `SequenceView`) take
`{ now?: Date; onOpen?: (id: string) => void }` and read the store directly.
This wave they also accept the editing pass-through props
`{ editingId?: string | null; onEdit?; onDelete?; onEditCommit?; onEditCancel? }`
(App owns `editingId` and the handlers; the views thread them into each `Row`).

## 5. Capture grammar — `web/lib/capture.ts` (IMPLEMENTED)

`parseInput(input, ref?) -> CaptureResult` and `previewLine(result) -> string`.
The bar grammar **is** the file grammar. Wave 2 builds `QuickAdd` UX on top of
this; the parser itself is stable. `CaptureResult`: `{ title, tags[], contexts[],
priority, keys{}, note, fields[] }`. `fields[]` carries `{ kind, label, span }`
for inline dimming.

## 6. Dates — `web/lib/dates.ts` (IMPLEMENTED)

`parseDate`, `parseDateStrict`, `toISO`, `formatShort` ("Jul 10"), `echoWords`
("Fri Jul 3"), `isOverdue`, `isOnOrBefore`. chrono `forwardDate:true` throughout.
ISO `YYYY-MM-DD` is the stored form.

## 7. Stub files — owner contracts

Each is a typed placeholder returning the documented neutral result. **Implement
the body; do not change the signature.**

| File | Signature | Wave 2 owner must implement |
|---|---|---|
| `src/recur.ts` | `nextOccurrence(rule: string, fromISO: string): string \| null` (→ `null`) · `expand(rule: string, fromISO: string, count?: number): string[]` (→ `[]`) | the `every…`→RRULE grammar; expand recurrence at runtime. `recur:` = fixed cadence from scheduled; `recur!:` = rolling from completion. (rrule dep installed.) |
| `src/criticmarkup.ts` | `comments(doc: Doc): Comment[]` (→ `[]`) · `commentsFor(doc: Doc, itemId: string): Comment[]` (→ `[]`); types `Author`, `Comment` | parse `{>> @author[id=… reply=… resolved]: body <<}` + edit-ops; anchor each to its item's `^id`. |
| `src/reconcile.ts` | `mergeAnnotated(originalText: string, annotatedText: string): MergeResult` (→ `{ ok:false, rejectedReason:"not implemented" }`) | paste round-trip: match by `^id`, validate every non-annotation byte unchanged, preview as diff. |
| `web/lib/sequence.ts` | `sequence(doc: Doc): SequenceResult` (stub: ready = open+doing, blocked = [], done = done+cancelled) | topological order by `after:`; surface unblocked-now; populate `blocked[].waitingOn`. |
| `web/views/TodayView.tsx` | `TodayView({ now?, onOpen? })` | full agenda presentation. **Filter logic already done** in `lib/today.ts` `todayItems(doc, nowISO)` — call it, do not duplicate. |
| `web/views/SequenceView.tsx` | `SequenceView({ now?, onOpen? })` | render the three bands from the real `sequence()`. |
| `web/components/CommandPalette.tsx` | `CommandPaletteProps` | the Cmd+K power surface; fuzzy, recency-ranked, shortcut-labeled. |
| `web/components/CommentGutter.tsx` | `CommentGutterProps` | right-margin threaded gutter; read via `commentsFor`. |
| `server/index.ts` | Hono `app`; routes `GET /d/:id`, `GET /d/:id.txt`, `POST /api/d/:id/comments` (all 501) | implement render/raw/write-back; raw = exact canonical bytes, `text/plain; charset=utf-8`, inline. |
| `server/store.ts` | `getSnapshot`, `putSnapshot`, `hasSnapshot`; `Snapshot` | real snapshot storage + capability model (signed read scope). |

## 8. Edit transforms — `web/lib/edit.ts` (PURE; added this wave)

PURE `Doc -> Doc` transforms (no React/store/IO); the input Doc is **never
mutated** — a new Doc is always returned (an unknown id returns a shallow copy,
so the result is still a fresh object). The store wires these to undo/redo +
autosave. "Descendant block" = the run of following nodes MORE indented than the
task; it ends at the first task/heading at the same-or-shallower indent (notes/
comments hang under the task and never close the block).

```ts
removeTask(doc: Doc, id: string): Doc          // drop the line + its descendant block
replaceBody(doc: Doc, id: string, body: string): Doc
  // re-parse `- [stateChar] <body> ^id`; PRESERVE original stateChar/indent/id;
  // strip any trailing ^id the caller leaves in `body`
insertChild(doc: Doc, parentId: string, line: string): Doc
  // re-indent `line` to parent.indent + 2; insert AFTER the parent's block
insertSibling(doc: Doc, afterId: string, line: string): Doc
  // same indent as afterId; insert AFTER afterId's block
// helpers also exported: indexById(doc, id), descendantEndIndex(doc, taskIdx)
```

## 9. Already implemented (do not reimplement)

`web/lib/today.ts` `todayItems(doc, nowISO)` — Today filter (open tasks with
`due:`/`scheduled:` ≤ now, overdue included, sorted priority desc then date asc).
`web/lib/capture.ts`, `web/lib/dates.ts`, `web/lib/ids.ts`, `web/lib/persist.ts`,
`web/lib/edit.ts`, the store (incl. the editing layer + undo/redo), and the
Document view are complete for MVP.

---

# Rune — Wave 4 Contracts (close-out wave)

Wave 4 adds in-app **Share**, an in-app **AI paste round-trip** (Review),
**attachments**, and a **Source** view. The foundation below (this agent's work)
is **locked**; the three parallel feature agents fill the stub bodies and build
their surface **against these contracts**. The same one rule holds: each agent
edits ONLY its owned stub file. `web/App.tsx`, `web/store/store.ts`,
`web/app.css`, `vite.config.ts`, `web/lib/share.ts`, and `web/lib/attach.ts` are
foundation — do not edit them; request a change instead.

The M0 core (`src/parse.ts`, `scan.ts`, `serialize.ts`, `types.ts`, `index.ts`)
and ALL of `test/` stay FROZEN. The server (`server/index.ts`) is already
implemented (`POST /api/publish`, `GET /d/:id`, `GET /d/:id.txt`,
`POST /api/d/:id/comments`) — do not change it for the UI work.

## W4.1 Dev proxy (vite.config.ts) — DONE

The app runs on **:5180**; the share server runs on **:8787**. `server.proxy`
forwards `/api` and `/d` to the server (`changeOrigin: true`), so in-app publish
and raw links are **same-origin** in dev. No CORS, no base URL to configure.
Run both: `pnpm dev` (app) + `pnpm serve:api` (server).

## W4.2 `web/lib/share.ts` (dependency-free)

```ts
interface PublishResult { id: string; writeToken: string; url: string; rawUrl: string } // url/rawUrl ABSOLUTE
function publish(text: string): Promise<PublishResult>
function unpublish(id: string): Promise<void>
function getWriteToken(id: string): string | null
```

POSTs `{ text }` to `/api/publish` (same-origin in prod and dev; the dev proxy
forwards `/api`+`/d` to :8787). Publish is **gated by the instance secret** — it
sends `Authorization: Bearer <rune:sync:token>` (the token pasted into Sync), so
publishing without a token throws. The response carries a per-snapshot
`writeToken` (the capability to append comments / unpublish); it is stashed in
`localStorage["rune:share:write:<id>"]`. `url`/`rawUrl` are absolutized against
the API base (or `location.origin`). `unpublish(id)` DELETEs `/api/d/:id` with
the stored write token. `VITE_RUNE_API` overrides the base for a split dev setup.
Throws a **clear Error** on a non-2xx response, a network failure, or a malformed
payload — `ShareDialog` surfaces `err.message` inline.

## W4.3 `web/lib/attach.ts` (DONE — PURE, unit-testable, locked)

```ts
interface Attachment { label: string; target: string }
function isUrl(text: string): boolean
  // true only for a single trimmed http(s)/mailto URL (no inner whitespace)
function urlToAttachment(url: string): Attachment
  // label = readable last path segment (decoded), else host; target = the url
function fileToAttachment(file: { name: string }): Attachment
  // label = file.name; target = "attachments/" + name (RELATIVE — bytes are
  // NOT copied; the browser sandbox forbids it)
function attachmentsFromTransfer(dt: TransferLike): Attachment[]
  // drop/paste intake: files -> attachments/<name>; else text/uri-list URLs;
  // else a plain-text single URL. [] when nothing attach-worthy (caller falls
  // through to normal paste). TransferLike = { files?, getData?(type) } so it is
  // testable without a real DataTransfer.
```

These are pure — no React/store/IO. An attachment is just a `[label](target)`
**link segment** on the task body (`attachmentsOf(task)` reads them back).

## W4.4 Store actions (DONE — locked) — `web/store/store.ts`

```ts
addAttachment(id: string, label: string, target: string): void
  // append a [label](target) link segment to the task body, via edit.replaceBody.
  // Idempotent per target (no duplicate). Label/target are sanitised so the link
  // grammar can't break. Undoable + autosaved (routes through commit()).
removeAttachment(id: string, target: string): void
  // drop EVERY link segment whose target === target; preserve all other tokens.
  // Undoable + autosaved.
```

Both go through the existing `commit()` funnel (undo/redo + localStorage
autosave), exactly like the other editing actions. The `.rune` text stays
canonical.

## W4.5 Attachment intake (DONE in Row.tsx + DetailCard.tsx)

`Row` and `DetailCard` accept **drag-and-drop + paste**:
- `dragover` over a row/the detail card shows a quiet drop affordance
  (`.rune-row.is-dropping` → a small "attach" marker; `.rune-detail.is-dropping`
  → a hairline ring). It is visible ONLY during dragover.
- **Multi-select + bulk edit**: shift-click extends a range (`selectRange`);
  ctrl/cmd-click toggles a row in/out of the set (`toggleSelect`, handled inside
  `Row`). On touch, a **long-press** (`Row` onTouchStart timer → `enterSelectMode`)
  starts "select mode" (`selectMode`) in which taps toggle rows; deselecting the
  last row or the bar's **Done** exits it. When 2+ rows are selected the `SelectionBar` (fixed, bottom) offers
  bulk **priority** (`setPriorityMany`), **due** (`setDueMany` — NL/ISO, empty
  clears, returns false on a near-miss), and **add-tag** (`addTagMany`); each is
  ONE undo step. `clearSelection` (bar's Clear) empties the set. Done/open,
  delete and indent remain in the ⌘K palette.
- A row also accepts an in-app REORDER drag (grip glyph `⠿`, fine pointers
  only): dragging it over another row shows a top/bottom insertion line
  (`.rune-row.is-drop-before` / `.is-drop-after`) and the drop moves the dragged
  task's whole block before/after the target — among SIBLINGS only (same indent,
  same section; never across a heading or indent level). Store: `moveTo` →
  `moveBlockTo`. Reorder drags carry the `application/x-rune-task` dataTransfer
  type; a file/URL drag still attaches. On touch a persistent
  `.rune-row-drag-touch` grip drives the SAME reorder via Pointer Events
  (`elementFromPoint` hit-test → `is-tdrop-*` insertion line → `onReorder` on
  release, with edge auto-scroll); its touchstart is stopped so a long-press
  select mode doesn't also arm.
- `drop`/`paste` runs `attachmentsFromTransfer(...)` and calls
  `addAttachment(id, label, target)` per result; a non-attach paste is left for
  the normal handler.
- `DetailCard` renders an **Attachments** section (only when present) listing
  `attachmentsOf(task)` as quiet mute-ink rows (NOT chips), each with a remove
  control and an open affordance: `window.open` for http(s)/mailto targets; a
  relative `attachments/…` ref shows a calm "in attachments/" location hint.

## W4.6 Wave 4 stub files — owner contracts

Each is a typed placeholder rendering a calm "coming in this wave" line.
**Implement the body; do not change the signature.** Read the file header for the
full implementation note.

| File | Signature | Owner must implement |
|---|---|---|
| `web/views/SourceView.tsx` | `SourceView(props: { onOpen?: (id: string) => void }): JSX.Element` | a full-height raw `.rune` editor (plain `<textarea>`, **no CodeMirror**) bound to the store: read `useStore(s=>s.text)`, write `useStore(s=>s.setText)` (undoable + autosaved). Quiet mono frame — see `.rune-source-editor` in app.css. |
| `web/components/ShareDialog.tsx` | `interface ShareDialogProps { open: boolean; onClose: () => void }` · `ShareDialog(props): JSX.Element \| null` | **consent fix: does NOT publish on open** — the user clicks "Create share link" to `publish(useStore.getState().text)`, then sees `url` + raw `.txt` as quiet copyable rows (Clipboard API) plus an **Unpublish** action (DELETE via the stored write token); surface a thrown Error calmly inline. `null` when `!open`. Chrome: `.rune-modal*`. |
| `web/components/ReviewModal.tsx` | `interface ReviewModalProps { open: boolean; onClose: () => void }` · `ReviewModal(props): JSX.Element \| null` | the AI paste round-trip: paste the re-emitted annotated doc → `mergeAnnotated(originalText, annotatedText)` (`@core/reconcile`); on `{ok:false}` show `rejectedReason` and accept nothing; on `{ok:true}` preview the diff + apply via `useStore.getState().setText(mergedText)`. `null` when `!open`. Chrome: `.rune-modal*`, paste box `.rune-modal-paste`. |

`App.tsx` already mounts all three: the **Source** view tab (4th, beside
Document/Today/Sequence) and the **Share**/**Review** topbar buttons own their
open/close state; `<ShareDialog>`/`<ReviewModal>` mount near `<DetailCard>`/
`<CommandPalette>`. The whole existing keyboard + editing model is untouched.

## W4.7 New CSS hooks (in `web/app.css`, token-based, hidden at rest)

`.rune-row.is-dropping` + `.rune-row-drop`; `.rune-detail.is-dropping`;
`.rune-detail-attachments` + `.rune-attach-list/-row/-open/-rel/-hint/-remove`;
`.rune-source` + `.rune-source-editor` + `.rune-source-stub`;
`.rune-modal-backdrop` + `.rune-modal` + `.rune-modal-title/-stub/-hint/-error/
-actions/-link/-link-value/-paste`. All quiet, hairlines, motion collapses under
`prefers-reduced-motion`.

---

# Rune — Wave 5 Contracts (point-and-click human editing layer)

Wave 5 makes **every structured field editable without typing tokens or using
the Source view**. The M0 core (`src/parse.ts`, `scan.ts`, `serialize.ts`,
`types.ts`, `index.ts`) and ALL of `test/` stay FROZEN; all 100 tests stay green.
Anchoring is **always by `^id`**, never line number. The `.rune` text stays
canonical: every produced line round-trips `serialize(parse(x)) === x`.

## W5.1 Pure edit helpers — `web/lib/edit.ts` (PURE; added this wave)

All return a NEW Doc, never mutate, total/defensive (unknown id → unchanged but
a fresh object). Comments are STANDALONE CriticMarkup lines anchored to a task by
being the nearest-following line under it.

```ts
interface InsertCommentOptions {
  author: string; commentId: string; reply?: string; resolved?: boolean; body: string;
}
insertComment(doc: Doc, itemId: string, opts: InsertCommentOptions): Doc
  // Builds `<indent>{>> @<author>[id=<id>[ reply=<r>][ resolved]]: <body> <<}` at
  // indent = task.indent + 2, inserted AFTER the task line and any note/comment
  // lines already directly under it (so criticmarkup.comments() anchors it here).
  // Body is sanitised: newlines/whitespace collapse to single spaces; a literal
  // `<<}` or `{>>` in the body is defused (gains a hairline space) so it cannot
  // break the delimiters. Empty body / unknown id / empty commentId -> unchanged.
setCommentResolved(doc: Doc, commentId: string, resolved: boolean): Doc
  // Rewrites ONLY the standalone comment line carrying `id=<commentId>`: adds or
  // removes the bare `resolved` attribute inside `[…]`, byte-identical otherwise.
  // Unknown id (or an inline-only comment) -> unchanged.
nextCommentId(doc: Doc): string
  // First unused `c-N` (1-based), scanning ALL ids via criticmarkup.comments.
commentNodeIndex(doc: Doc, commentId: string): number
  // Doc-node index of the standalone comment line carrying `commentId`, or -1.
```

## W5.2 Store — `web/store/store.ts`

New state field (default): `author: string` (= `"ben"`). All new actions route
through the existing `commit()` funnel (undoable + localStorage autosaved) and
mirror the body-rebuild approach, so produced lines round-trip.

```ts
setAuthor(name: string): void
  // Set the author stamped on new comments. Empty name -> no change.
toggleContext(id: string, ctx: string): void
  // Add/remove an `@ctx` token (no leading `@`), mirroring toggleTag.
setScheduled(id: string, dateInput: string): void
  // Set/clear the `scheduled:` key from a NL/ISO date (same parse path as setDue;
  // "" clears; unparseable -> no change).
setRecurrence(id: string, rule: string, rolling: boolean): void
  // Set `recur:` (rolling=false) or `recur!:` (rolling=true) to the english rule
  // (quoted when it has spaces). ALWAYS clears BOTH keys first; empty rule clears.
addComment(itemId: string, body: string): void
  // Mint nextCommentId, insertComment with author = get().author. No-op on empty.
replyToComment(itemId: string, parentCommentId: string, body: string): void
  // insertComment with reply = parentCommentId. No-op on empty.
resolveComment(commentId: string, resolved: boolean): void
  // setCommentResolved by comment id.
// (setState already existed — reused for the inspector's State control.)
```

`rebuildBody` gained `addContext` / `removeContext` to `BodyChange` (mirroring
`addTag` / `removeTag`).

## W5.3 Component prop contracts (LOCKED — pickers are stubs)

```ts
// DatePicker.tsx (STUB; calm free-form input for now)
interface DatePickerProps { label: string; value: string; onCommit: (input: string) => void }
  // value = stored ISO ("" = none); onCommit receives a NL OR ISO string OR ""
  // to clear (the store parses it).

// DependencyPicker.tsx (STUB; pick by TITLE, never by typing ^ids)
interface DependencyPickerProps {
  value: string[]; options: Array<{ id: string; title: string }>;
  onCommit: (ids: string[]) => void;
}

// RecurrencePicker.tsx (STUB)
interface RecurrencePickerProps {
  rule: string; rolling: boolean; onCommit: (rule: string, rolling: boolean) => void;
}
  // rule = "" means none; rolling distinguishes recur: (false) from recur!: (true).

// CommentGutter.tsx (extended — now interactive)
interface CommentGutterProps {
  doc: Doc; itemId: string | null;
  onReply?: (parentCommentId: string, body: string) => void;   // adds a Reply control + inline composer
  onResolve?: (commentId: string, resolved: boolean) => void;  // adds a Resolve/Reopen toggle per thread
}
  // When neither handler is passed the gutter is a pure display surface (back-compat).

// DetailCard.tsx (REBUILT — full point-and-click inspector)
interface DetailCardProps { id: string; onClose: () => void }
  // Title (rename), ^id, State (setState ×5), Priority (setPriority), Due
  // (DatePicker→setDue), Scheduled (DatePicker→setScheduled, now EDITABLE),
  // Recurrence (RecurrencePicker→setRecurrence), Tags (toggleTag) + Contexts
  // (toggleContext) with <datalist> autocomplete from all doc tags/contexts,
  // Dependencies (DependencyPicker→setAfter, by title), Attachments, Add sub-task,
  // Delete, and the interactive CommentGutter + an "Add a comment…" composer
  // (addComment / replyToComment / resolveComment).

// Row.tsx — a normal click on the row body now selects AND opens the inspector
// (onOpen(id)); a quiet hover ✎ glyph (.rune-row-inspect) opens it too. The
// checkbox/delete control stop propagation; inline-edit mode is a separate render
// branch, so click-to-inspect never interferes with the e-key editor or j/k.
```

## W5.4 New CSS hooks (`web/app.css`, token-based, hidden at rest)

`.rune-row-inspect`; `.rune-detail-state` + `.rune-detail-state-opt`;
`.rune-picker` + `.rune-picker-input`; `.rune-recur-wrap` + `.rune-recur-rolling`;
`.rune-dep-wrap/-list/-row/-title/-remove/-add/-empty`; `.rune-comment-composer`
(+ `-reply-composer`) + `.rune-comment-input/-composer-actions/-send/-cancel`;
`.rune-comment-actions` + `.rune-comment-action`. All quiet, hairlines only, motion
collapses under `prefers-reduced-motion`.

---

# Rune — Wave 6 Contracts (keyboard/a11y hardening)

Wave 6 fixes verified UI/keyboard/accessibility bugs. It adds two UI-owned lib
modules (no store dependency), a handful of component-prop extensions, and
catches this document up with the store surface added in the previous phase.

## W6.1 Store surface added last phase (documented here; store.ts unchanged)

```ts
removeMany(ids: string[]): void
  // Remove many task blocks in a SINGLE commit — one undo step, one sync push.
  // Ids resolving to already-removed descendants are skipped; a fully no-op
  // call pushes nothing. The palette's "Clear completed (N)" uses this.

interface DeleteTicket { block: string; afterId: string | null }
removeTaskWithTicket(id: string): DeleteTicket | null
  // Remove a task block and return a ticket capturing the removed lines plus
  // their anchor (the nearest preceding task id, null = top of document).
  // Returns null for an unknown id. Powers the SCOPED delete-undo toast.
restoreDeleted(ticket: DeleteTicket): void
  // Re-insert a ticketed block as a normal (undoable) commit — after its
  // original predecessor when it still exists, else appended at the end.
  // The App's "Task deleted · Undo" toast calls this, NEVER global undo()
  // (which could revert whatever the most recent action happened to be).

interface CommitOptions { coalesceKey?: string; skipIfEqual?: boolean }
setText(text: string, opts?: CommitOptions): void
  // `coalesceKey` folds a burst of same-key commits (Source-view keystrokes)
  // into ONE undo step; `skipIfEqual` (default true) drops byte-identical
  // commits so no-op edits never push phantom undo entries.
```

## W6.2 `web/lib/modalScope.ts` (UI-owned; no store dep)

```ts
pushModalScope(label?: string): symbol   // register an open modal; returns token
popModalScope(token: symbol): void       // idempotent
isModalScopeActive(): boolean            // true while ANY modal/menu is open
useModalScope(active: boolean): void     // React wrapper: scope held while active
```

The App's global window-keydown handler early-returns when
`isModalScopeActive()` — so j/k/Space/Backspace/… can never act on the list
behind a backdrop. Registered by: CommandPalette, DetailCard, ShareDialog,
SyncDialog, ReviewModal, HelpSheet, and the mobile ⋯ overflow popover. This
replaces the old ad-hoc `helpOpen`/`overflowOpen` special-cases. Consequence:
every modal owns its OWN Esc (and the palette its own ⌘K toggle-close).

## W6.3 `web/lib/useModalFocus.ts` (shared focus trap, WCAG 2.4.3/2.1.2)

```ts
useModalFocus(open: boolean, containerRef: RefObject<HTMLElement>): void
```

On open, focus moves into the dialog (first focusable, else the container);
Tab/Shift+Tab wrap within it; on close, focus returns to the previously-focused
element. Applied to DetailCard, ShareDialog, SyncDialog, ReviewModal, HelpSheet
(CommandPalette keeps its own single-input trap).

## W6.4 Component-prop extensions (backwards-compatible)

```ts
// CommandPalette.tsx
type PaletteView = 'document' | 'today' | 'sequence' | 'source';
interface CommandPaletteProps {
  open: boolean; onClose: () => void;
  onGoToView?: (view: PaletteView) => void;  // "Go to Document/Today/…" rows
  onOpenHelp?: () => void;                   // "Keyboard shortcuts" row
}
// New rows: Go to <view> ×4, Hide/Show completed (setHideDone), Indent/Outdent
// selected (keycaps Tab/⇧Tab), Keyboard shortcuts. "Clear completed (N)" now
// calls removeMany (one undo step) instead of looping remove().

// DetailCard.tsx — App renders it KEYED BY ID (<DetailCard key={detailId} …/>)
// so retargeting remounts the card and no draft survives across tasks.
interface DetailCardProps {
  id: string; onClose: () => void;
  onNotice?: (message: string) => void;      // near-miss toasts (bad date/rule)
}

// DatePicker.tsx / RecurrencePicker.tsx — validate BEFORE committing; the store
// silently no-ops on an unparseable value, so the picker surfaces it instead.
interface DatePickerProps  { …; onInvalid?: (input: string) => void }
interface RecurrencePickerProps { …; onInvalid?: (rule: string) => void }

// QuickAdd.tsx — Shift+Enter = add AND open (BRIEF §3).
interface QuickAddProps {
  onOpenPalette?: () => void;
  onOpen?: (id: string) => void;             // open the new task's detail card
  onNotice?: (message: string) => void;
}
```

## W6.5 A11y semantics (Row / Checkbox / App)

- `Checkbox` is tabbable again (the `tabIndex={-1}` opt-out is gone).
- `Row`: `aria-selected` (invalid on `role="listitem"`) → `aria-current` for the
  selected row; `aria-level={depth + 1}` for sub-task depth; the task STATE is
  folded into the accessible name via a `.rune-visually-hidden` span.
- Row hover controls (✎ inspect / ✏ edit / ✕ delete) are keyboard-reachable;
  `:focus-visible` reveals them exactly like hover (CSS in app.css).
- App mounts ONE visually-hidden polite live region announcing single-item
  Added/Completed/Deleted deltas; SyncDialog's status line is `aria-live=
  "polite"` and its error line `role="alert"`.
- Toasts split: message-only vs undo-toasts. Only genuinely undoable actions
  (delete via ticket) render an Undo button; "Sync failed" etc. cannot revert
  an unrelated edit anymore.
- ⌘O (open file) and ⌘S (save) are really bound in App.tsx (preventDefault),
  matching the palette keycaps.

## W6.6 New CSS hooks

`.rune-visually-hidden` (clip-pattern, used by the live region + row state
names); `:focus-visible` reveal rules for `.rune-row-delete` /
`.rune-row-inspect` / `.rune-row-edit`.

---

# Rune — Wave 7 Contracts (filter, multi-select, bulk verbs, Today count)

Wave 7 ships the final feature tier from UX-REVIEW "Bigger bets": the `/`
grammar filter on the Document view, multi-select with bulk verbs, the Today
tab count, the palette Jump upgrade, and the palette due-prompt near-miss fix.

## W7.1 `web/lib/filter.ts` (PURE; no DOM, no store)

```ts
interface CompiledFilter {
  tags: string[]; contexts: string[]; minPriority: number; words: string[];
  overdue: boolean; dueOnOrBefore: string | null; isEmpty: boolean;
}
compileFilter(query: string, ref?: Date): CompiledFilter
matchesFilter(task: TaskNode, f: CompiledFilter, now?: Date): boolean
taskMatchesQuery(task: TaskNode, query: string, now?: Date): boolean
```

The query IS the capture grammar — compileFilter runs `parseInput()` (the same
one the quick-add bar uses): `#tag` (a parent tag matches nested children),
`@context`, `!`/`!!`/`!!!` = priority ≥ n, bare words = case-insensitive TITLE
substrings (ANDed), `overdue` = has a past due:/scheduled:, `due:<ISO>` or
`due <NL date>` = due/scheduled on-or-before that date. An empty query matches
everything (`isEmpty`).

**Filter persistence decision: the filter RESETS when the input collapses.**
The `/` bar collapses on Esc (clears + collapses) or on blurring an EMPTY
input; blurring a non-empty input keeps it visible + active. A collapsed
filter never keeps narrowing the list — invisible filter state would be the
exact kind of quiet lie the no-anxiety-chrome principle forbids. App owns only
the `filterOpen` flag (the `/` key is global, Document view only, not while
typing/modal open); the query string lives in DocumentView and dies on
collapse. While filtering, matching tasks render with their ANCESTOR task
chain (hierarchy stays legible); non-matching rows, headings, notes and blanks
are ABSENT, not dimmed. `visibleTaskIds()` (the `.rune-row[data-id]` DOM walk)
therefore automatically confines j/k / range extension to the filtered set.

## W7.2 Store — selection slice

```ts
selectedId: string | null      // the lead/focus row (unchanged meaning)
selectedIds: string[]          // the full multi-select set; ALWAYS contains
                               // selectedId ([] when nothing selected)
anchorId: string | null        // the fixed end a range extends from

select(id: string | null): void
  // Plain selection: collapses to a single row ([] on null) and re-anchors.
selectRange(leadId: string, visibleIds: string[]): void
  // Extend from anchorId (else selectedId) to leadId across the given
  // VISIBLE row order; leadId becomes selectedId, the anchor is preserved.
  // Anchor/lead not in visibleIds -> falls back to a single selection.
```

Every row-removal path (remove / removeMany / removeTaskWithTicket /
removeManyWithTicket) prunes ids that no longer resolve from
selectedIds/selectedId/anchorId.

## W7.3 Store — bulk verbs (each = ONE commit = one undo step)

All fold the existing single-task transform over the evolving Doc and commit
once; per-id no-ops are skipped and a fully no-op batch commits nothing
(skipIfEqual semantics preserved).

```ts
toggleManyDone(ids: string[]): void   // all done -> reopen all; else all done
                                      // (done: stamp + recurrence spawn intact)
setStateMany(ids: string[], state: State): void
setPriorityMany(ids: string[], level: number): void   // 0 clears
addTagMany(ids: string[], tag: string): void           // adds only where absent
indentMany(ids: string[]): void
outdentMany(ids: string[]): void

interface BulkDeleteTicket { tickets: DeleteTicket[] }
removeManyWithTicket(ids: string[]): BulkDeleteTicket | null
  // Removes every resolvable block in ONE commit and returns tickets ordered
  // by original position. An id inside an earlier-captured block (descendant
  // of another deleted task) is NOT double-captured. null when nothing resolves.
restoreDeletedMany(bulk: BulkDeleteTicket): void
  // Re-inserts every block in ONE commit (the "N tasks deleted" toast's Undo).
```

## W7.4 Store — changed signature

```ts
setDue(id: string, dateInput: string): boolean
  // NOW RETURNS whether the change was applied: false when the id is unknown
  // or the date is unparseable (the mutation no-ops). Callers surface the
  // near-miss ("Couldn't read that date") instead of silence; the palette's
  // due prompt does this, mirroring the DatePicker onInvalid pattern.
```

## W7.5 Keyboard / interaction model additions (App.tsx / Row.tsx)

- `/` (global, Document view, not typing, no modal scope) reveals the filter.
- Shift+click on a row extends the range from the anchor over the RENDERED
  rows (native shift-click text selection is suppressed); plain click / j/k
  collapse to a single selection.
- Shift+J/K and Shift+Arrows extend the selection down/up over visibleTaskIds.
- With >1 selected: Space/Enter = toggleManyDone, Backspace/Delete =
  removeManyWithTicket + ONE "N tasks deleted · Undo" toast, Tab/Shift+Tab =
  indentMany/outdentMany, Esc = collapse to the lead row (then the usual
  Esc ladder).
- Selected rows reuse the existing `.rune-row.is-selected` tint. NO checkboxes,
  NO toolbar — the palette placeholder "N selected" is the only indicator.

## W7.6 CommandPalette

```ts
interface CommandPaletteProps {
  …;
  onNotice?: (message: string) => void;  // near-miss toasts (bad due date)
}
```

- With >1 selected the selection-scoped commands are REPLACED by bulk ones:
  Mark N done/open, Delete N (removeMany, one ⌘Z), Set/Clear priority on N,
  Add tag to N… (prompt -> addTagMany), Indent/Outdent N.
- Jump rows now fold `#tags` and `@contexts` into the fuzzy haystack, and on
  run select AND scroll the row to viewport center —
  `scrollIntoView({ block:'center', behavior:'smooth' })`, `'auto'` under
  prefers-reduced-motion.

## W7.7 Today tab count (App.tsx ViewTab)

`ViewTab` gains `count?: number` — rendered as a quiet `·N` after the label
("Today ·3"): mute ink, tabular numerals, no badge shape, no red, and ABSENT
(not "·0") when zero. Driven live by `todayItems(doc, toISO(new Date()))`.

## W7.8 New CSS hooks

`.rune-filter` + `.rune-filter-input` (the thin hairline sibling of the
quick-add input: meta-size, mute ink, transparent, no shadow);
`.rune-viewtab-count`.

---

# Rune — Zero-setup sync (trusted-network servers)

Adds "open the app on any tailnet device → the one shared doc is just there,
syncing, no setup" WITHOUT weakening the wave-1 safety model (conditional PUT
`If-Match`, `409` conflict surfacing, dirty-local guard on adopt, flush-on-hide,
push timeout — all unchanged).

## Server — `RUNE_OPEN_SYNC=1` (`server/doc.ts`)

When set, `GET`/`PUT /api/doc` (and nothing else) accept requests with **no**
bearer token. A request WITH a non-empty bearer must still match `RUNE_TOKEN`
(else `401`, so a misconfig fails loudly). Default (unset) is unchanged:
strictly `RUNE_TOKEN`-gated (`503` when unset, `401` on a bad/missing token).
**Share publish stays `RUNE_TOKEN`-gated regardless** — separate capability.

## Discovery / probe (no new endpoint)

`GET /api/doc` with **no** Authorization header IS the probe: `200` ⇒ open
server, `401` ⇒ token required. The client runs it once via the existing
`pullDoc('')` path.

## `pullDoc` / `pushDoc` empty-token contract (`web/lib/persist.ts`)

Both take a `token: string`. An **empty** token omits the `Authorization` header
entirely (never sends `Bearer ` with nothing after it); a non-empty token sends
`Bearer <token>` as before. This is what makes the token-less probe and open-mode
sync requests work.

## Store — `syncToken` semantics + auto-enable (`web/store/store.ts`)

`syncToken: string | null` now has three meanings:

| value | meaning |
|---|---|
| `null` | sync not configured on this device |
| `''` | configured for an **open** (token-less) server |
| `"…"` | configured with a bearer token |

Every "is sync configured?" guard tests `syncToken !== null` (not truthiness),
so the empty-token open case counts as configured. New state
`syncOpen: boolean` = the server is known to sync without a token (drives the
dialog). Seeded at create() from `lsGet('rune:sync:token') === ''` and set true
by a successful probe.

**Auto-enable rules (run in `init()` when sync is NOT already configured):**

1. Skip entirely if `syncEnabled` or `syncToken !== null` (already configured).
2. Skip if the user opted out — localStorage **`rune:sync:optout` = `'1'`** (set
   when the user turns sync **off** in the dialog; cleared when they enable it).
3. Skip if not served from a real origin (`file://` / no `window.location`).
4. Otherwise probe `pullDoc('')`. On success → set `syncEnabled`, `syncToken=''`,
   `syncOpen=true`, persist (`rune:sync:enabled='1'`, `rune:sync:token=''`), then
   run the **existing** `reconcileSyncOnInit` (adopt-when-clean / seed-empty-server
   / dirty-conflict guards all unchanged). On any throw (`401`/offline) → stay
   off, silently.

Consequence of reusing the guards unchanged: a brand-new device (`lastSynced`
null) whose local text differs from a non-empty server surfaces a **conflict**
(local kept, Reload/Keep-mine in the dialog) rather than silently adopting —
this is the wave-1 safety behavior, preserved deliberately.

## SyncDialog (`web/components/SyncDialog.tsx`)

Status/control surface. When `syncOpen`: hide the token field, present sync as a
simple on/off ("Syncing with this server"), and Enable takes the token-less path
(no "replaces your list" confirm). When the server is token-gated: the existing
token field + Enable/Disable/Sync-now flow is unchanged. All conflict UI
(Reload / Keep-mine) is untouched in both modes.

---

# Rune — Data-loss hardening (never sync the onboarding seed; precondition-always)

Fixes a real incident: a fresh device seeded with the bundled onboarding doc
(`web/public/work.rune`) auto-enabled sync and, because it had never synced
(`lastSyncedUpdatedAt = null`), sent an **unconditional** PUT that overwrote the
owner's real list on the server. Three layers now make "a default overwriting
your real list" impossible.

## 1. Precondition-always on push (`doPush` + `web/lib/persist.ts` + `server/doc.ts`)

Once sync is enabled, **every** push carries a precondition — there is no
unconditional auto-PUT:

| device state | precondition sent |
|---|---|
| a real `lastSyncedUpdatedAt` stamp | `If-Match: <stamp>` (unchanged) |
| never synced (`lastSyncedUpdatedAt = null`) | **expect-empty** sentinel |
| explicit **Keep-mine** force only | none (unconditional overwrite) |

The **expect-empty** encoding is the sentinel string
`EXPECT_EMPTY_PRECONDITION = 'expect-empty'` (exported from `web/lib/persist.ts`;
mirrored as `EXPECT_EMPTY` in `server/doc.ts`). It is sent as **both** an
`If-Match` header **and** a `baseUpdatedAt` body field (a keepalive flush can drop
the header). It was chosen over an empty header value (fragile) and is
distinguishable from a real `updatedAt` (always an ISO timestamp) and from "no
precondition". `pushDoc(token, text, { expectEmpty: true })` sets it.

**Server CAS (`PUT /api/doc`):** an expect-empty precondition writes **only** when
no doc exists (`updatedAt === ''`) and **409s** otherwise (returning the current
doc). Stamp preconditions behave exactly as before. An unconditional PUT (no
precondition) still overwrites — that path is retained ONLY for (a) wire-compat
with old clients driving a default-token server and (b) the explicit force path.

## 2. The onboarding seed is never sync-authoritative (pristine tracking)

localStorage **`rune:pristine` = `'1'`** is set when the store initialises from
the bundled seed (a fresh device with no localStorage doc), and cleared
**permanently on the first user-driven commit** (any mutation through `commit()`
— not `loadText`-from-server). Belt-and-braces: even without the flag, local text
**byte-identical to the bundled seed** counts as pristine (`isPristine()`; the
seed text is captured in `init()`).

While pristine:

- `doPush` / `scheduleSyncPush` **no-op** (the seed is never pushed).
- Reconcile / auto-enable / manual enable: a **non-empty** server doc is adopted
  **unconditionally** (no conflict, no push — `adoptRemote` also clears pristine);
  an **empty** server is left empty (the seed is never used to seed a shared
  server — it stays empty until real content exists).

Consequence: a brand-new device shows the onboarding doc locally but can only ever
*receive* a shared list, never *send* the seed. The first real edit clears
pristine and normal sync resumes (seeding an empty server then goes out under an
expect-empty precondition).

## 3. A surfaced conflict blocks pushes until resolved

While `syncConflict` is set, `doPush` / `scheduleSyncPush` / the flush-on-hide
path all **no-op** (`syncNow` too — it no longer bypasses the guard). Resolution:

- **Reload** (`reloadFromSync`) — adopt the server version (replaces local).
- **Keep mine** (`dismissConflict`) — the **only** place an overwrite of a
  *differing* server doc is allowed, and it is **explicit**: it clears the
  conflict and issues a **force** push (unconditional PUT), then stamps
  `lastSyncedUpdatedAt` from the result.

**`dismissConflict` semantics (settled):** Keep-mine actively **force-overwrites
the server** with local. It does *not* merely hide the banner and leave local
silently dirty (the old behaviour stamped the server's `updatedAt` as the base and
scheduled a conditional push, which was both implicit and easy to mistake for
"dismiss"). The force PUT is the single sanctioned, user-initiated overwrite — it
is never a default.
