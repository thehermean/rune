All key facts confirmed: zero width/pointer media queries, no `:focus-visible`, `visibleTaskIds` uses raw `tasks(doc)`, `move()` swaps lines without children, no `syncStatus`/`syncError` consumer outside SyncDialog, and no service worker. The findings are accurate. Here is the synthesized plan.

---

# Rune — Usability Improvement Plan

## 1. Verdict

Rune's core loop is genuinely excellent: the pinned QuickAdd bar with live in-words preview, Enter-to-add-and-keep-focus, and the `c`-from-anywhere hotkey make capture fast and calm, and the local data path is unusually safe (single mutation funnel, uniform undo/redo, autosave on every commit). The problem is that almost none of this is *discoverable or reachable* outside the author's own hands. The three biggest gaps: (1) **the entire keyboard model is invisible** — no `?`, no help sheet, no key hints in the palette, and even the palette itself has no on-screen entry point; (2) **there is not one width/pointer media query in the whole codebase**, so the phone (a stated primary device) gets a desktop layout literally shrunk, with an 11-button topbar that overflows and hover-only controls that never reveal on touch; and (3) **sync confidence is broken** — a failed background push is indistinguishable from success anywhere outside a dialog nobody has open, and last-write-wins silently clobbers a newer device. Accessibility compounds all three: no visible focus ring anywhere, and the core checkbox is `tabIndex={-1}`. The good news is that nearly every fix is *subtractive or invisible* — it removes chrome or hides behind progressive disclosure — so the calm north star is a help, not an obstacle.

## 2. Themes

- **Discoverability (the tribal-knowledge tax).** The keyboard model, the command palette, and the capture grammar all live only in source and comments; a pointer-first or first-time user cannot find the app's power surface at all.
- **Mobile/touch reality.** Zero responsive handling: topbar overflow, hover-reveal controls unreachable on touch, sub-44px tap targets, keyboard-only editing verbs, and inspector-behind-keyboard. The app is desktop-shrunk, not reflowed.
- **Sync confidence & data safety.** Sync health is invisible on the always-on surface, last-write-wins clobbers silently, the "Undo" toast undoes the wrong thing, and the PWA is dead offline.
- **Findability at scale.** No search or filter; `j/k` navigates the raw doc rather than what's on screen; reorder abandons sub-tasks. Friction that compounds precisely as a real list grows.
- **Accessibility as table stakes.** No `:focus-visible`, no modal focus trap/restore, non-tabbable core controls, invalid list semantics, and `--faint` failing 4.5:1 — all fixable without a single visible-at-rest pixel.
- **Feedback on near-misses.** Silent no-ops (unparseable dates, tag-only add, reference-only attachment clicks, phone Save-downloads-a-copy) teach the user the app is unresponsive.

## 3. The plan — sequenced

### Quick wins (S — do first)

- **Add a `?` shortcuts/help sheet + capture-grammar section.** → Claude Design. A quiet, hairline-ruled two-column key→action list reusing existing `rune-modal*`/`KEYCAP_STYLE`, opened by `?` and a "Keyboard shortcuts" palette row. Fold the fuller capture grammar (`due`/`start`, `p1-p3`, `#proj/sub`, `key:value`) in as one section. *Why:* single highest-leverage discoverability fix — it makes the whole keyboard-fast app learnable without any always-on chrome. *Effort: S.*
- **Add a single `⌘K` affordance to reach the palette.** → Claude Design. One mute-ink `⌘K` token at the trailing edge of the QuickAdd bar. *Why:* the palette is "the single power surface" yet has no visible trigger — this one token unlocks every action for pointer- and touch-first users, and is the on-screen palette opener touch needs. *Effort: S.*
- **Show the global keycap on matching palette rows** (`e`, `o`, `⌘K`, etc.). *Why:* the palette teaches the keyboard as a side effect, no new surface. *Effort: S.*
- **Fix `visibleTaskIds()` to walk the rendered rows, not the raw doc.** Derive `j/k`/Arrow/`⌘↑↓` from each view's actual ordered+`hideDone`-filtered list. *Why:* today the cursor drives a list you're not looking at (invisible rows in Today, hidden done rows) — the single highest-leverage keyboard *correctness* fix, no UI. *Effort: S.*
- **Add a global `:focus-visible` ring.** → Claude Design. One additive `:where(button,a,input,textarea,[tabindex]):focus-visible` block using the sanctioned `--accent`. *Why:* WCAG 2.4.7; keyboard users currently cannot see focus at all. Because it's `:focus-visible`, pointer users see nothing — zero clutter. *Effort: S.*
- **Nudge `--faint` and the light-theme accent to clear 4.5:1.** → Claude Design. Darken/lighten `--faint`; move readable content (filename, attachment labels, keycaps) to `--mute`; add a darker accent variant for text/links on white. *Why:* WCAG 1.4.3; pure token tweak, preserves the quiet-ink hierarchy. *Effort: S.*
- **Reflect sync state on the topbar Sync button.** → Claude Design. A hairline dot: neutral when synced, accent while syncing, `--danger` only on error (with `title=syncError`); optional one-line toast on transition into error. *Why:* today a failed push is invisible — the core cross-device data-trust gap. The dot only earns attention when broken, so no anxiety badge in the healthy case. *Effort: S.*
- **Wire near-miss feedback through the existing `showToast`.** "Add a title, not just a tag" (tag-only no-op), "Couldn't read that date" (unparseable due/scheduled), attachment/save-download explanations. *Why:* silent no-ops teach users the app is broken; reuses the delete-toast surface, no new chrome. *Effort: S.*
- **Add `title` tooltips to Review/Share/Sync.** Matching the existing Open-folder pattern. *Why:* the labels name the feature, not its purpose ("Review" reads as "review my tasks", not AI paste round-trip). Zero layout change. *Effort: S.*
- **Ship a purpose-built onboarding seed** replacing `work.rune` (the dev's own backlog). 3-5 tutorial-tasks that still demonstrate one tag/context/priority/due each, but framed as a lesson. *Why:* first impression currently reads as leaked internal data with raw `{>> @ai <<}`/`[[wikilink]]` tokens. *Effort: S.*

### Core improvements (M)

- **Add a mobile breakpoint that *collapses* the topbar.** → Claude Design. At `max-width: 640px`, keep only wordmark + view switch + QuickAdd + Hide done; fold Review/Share/Sync/Open/Save/theme into the palette or one overflow control; gate Chromium-only "Open folder" behind a capability check. *Design note:* this **removes** clutter on small screens — squarely on-vision, not a bolt-on mobile skin. Fix the QuickAdd `top:56px` magic number to derive from a shared header-height token so it can't desync when the header wraps. *Effort: M.*
- **Make row controls touch-reachable and tap intent honest.** → Claude Design. On `@media (pointer: coarse)`: render `✎`/`✕` at reduced opacity persistently (or on selection); give checkbox/`✎`/`✕`/close/dismiss a 44px min hit-area via invisible padding while the glyph stays hairline-tiny; and **single-tap selects, doesn't open the modal** — the inspector opens via the now-visible `✎`. *Why:* on touch these controls are opacity:0-forever and there's no delete path at all; and every tap on a row body currently throws a full modal. *Design note:* the visible mark stays small — only the hit box grows. *Effort: M.*
- **Decouple click from inspector on desktop too.** Single click = select only; open the inspector on `✎`/`o`/double-click (all already exist). *Why:* the heaviest surface is bound to the lightest, most frequent gesture, fighting progressive disclosure. Removes a surprise, no new chrome. *Effort: M.*
- **Add modal focus trap + restore** via one shared `useModalFocus(open, ref)` hook applied to DetailCard/Share/Sync/Review. *Why:* four of five modals let Tab walk out behind the backdrop and drop focus to `<body>` on close (WCAG 2.4.3/2.1.2). Invisible — no visual change. *Effort: M.*
- **Make the task checkbox tabbable and fix row semantics.** Remove `tabIndex={-1}` from Checkbox (it already has good `aria-label`/`aria-pressed`); drop the invalid `aria-selected` on `role="listitem"`, use `aria-current` for selection and `aria-level` for depth, and include state in each row's accessible name. *Why:* today a screen-reader user can hear titles but cannot complete, open, or delete a task (WCAG 2.1.1). The bespoke `j/k` model stays for power users; it just can't be the *only* path. *Effort: M.*
- **Make `move()` relocate the whole block, not swap one line.** Use the existing `descendantEndIndex` to move the parent with its descendant range past the next sibling's block. *Why:* reorder silently strands sub-tasks under the wrong parent — a data-shaped surprise. Same keybinding, no UI. *Effort: M.*
- **Pull-before-push + focus-pull for sync.** → Claude Design (one calm note only). Conditional PUT keyed on `updatedAt` (409 on mismatch); on conflict show a quiet "This list changed on another device — reload?" rather than clobbering; pull on `visibilitychange`. *Why:* last-write-wins currently loses a newer device's edits with zero signal. Turns silent loss into a recoverable choice. *Effort: M.*
- **Add missing palette verbs.** Go to Today/Document/Sequence/Source, Toggle Hide done, Indent/Outdent selected. *Why:* the palette claims to be the single power surface but a keyboard user reaching for "go to Today" finds nothing. Thin wrappers over existing state. *Effort: M.*
- **Add a visually-hidden `aria-live` region** for add/complete/delete and wrap SyncDialog status/error in `aria-live`/`role="alert"`. *Why:* state changes are currently silent to AT. Zero visual clutter. *Effort: M.*
- **Scope the delete Undo to a captured snapshot** rather than calling global `undo()`. *Why:* intervening edits within the 5s window make "Undo" revert the wrong action while the delete stands — the toast lies. *Effort: M (small-M).*
- **Coalesce Source-view keystrokes into one undo step.** Debounce/merge consecutive `setText` commits. *Why:* typing in Source evicts all real undo history (HISTORY_LIMIT=100) and rewinds one char at a time — the safety net is degraded exactly where edits are riskiest. *Effort: M (small-M).*
- **PWA offline shell.** Add `apple-mobile-web-app-*` meta + PNG icons (192/512/180) and a minimal precache service worker. *Why:* the installed app is dead offline today, contradicting the "one file, on your phone" promise. Invisible to the UI. *Effort: M.*
- **iOS 16px inputs on coarse pointers** to suppress auto-zoom, and top-anchored full-height inspector sheet with `100dvh` + `env(safe-area-inset-*)`. → Claude Design. *Why:* every field tap currently jarring-zooms, and focused fields hide behind the on-screen keyboard. *Effort: M.*

### Bigger bets (L)

- **Grammar-driven filter on the Document view.** → Claude Design. A slim hairline input revealed by `/`, collapsing to nothing when empty, that narrows visible rows using the *same* `parseInput` grammar (`#finance`, `@home`, `!!!`, `overdue`). *Why:* at 100+ tasks the only "find" is title-only palette Jump (which doesn't even scroll into view) — the daily driver's most common growing-list operation is impossible. *Risk/decision:* the query IS the grammar, so it's plain-text-first and adds one restrained input, not chrome — but decide up front whether the filtered set persists after the input collapses or resets. Smaller first step: make palette Jump also match tags/contexts and `scrollIntoView`. *Effort: L.*
- **Lightweight multi-select + bulk verbs.** Shift-click / shift-`j`/`k` to extend selection, then existing palette verbs (done/delete/priority/tag) operate over the set; a subtle count in the palette placeholder is the only indicator. *Why:* triaging a 100+ list one row at a time is where friction compounds fastest after search. *Risk/decision:* `store.ts` uses a single `selectedId` today, so this is real refactor work; keep it **invisible until engaged** — no persistent checkboxes or toolbar, which would be anxiety chrome. *Effort: L.*
- **Overdue/due-today count on the Today tab label** (e.g. "Today ·3"), driven by `todayItems`. *Why:* a dated todo on a phone has *no* nudge at all — items go overdue silently. *Risk/decision:* start with the count only (calm, no popups). Local Notifications stay strictly opt-in and gated behind the service worker, or they become the exact anxiety chrome the vision forbids. *Effort: L (count alone is M; notifications are the L part).*

## 4. What NOT to do

- **Don't add always-on keyboard legends, row toolbars, or persistent checkboxes.** The fix for discoverability is *progressive disclosure* (`?` sheet, palette hints) and for bulk-select is *invisible-until-engaged*. Anything on screen at rest violates the calm/uncluttered north star.
- **Don't add push notifications, badges, or a sync "success" toast in the healthy case.** Nudges must be opt-in and quiet; the sync dot should earn attention only on error. Green "Synced!" confirmations are exactly the anxiety chrome to avoid.
- **Don't build a separate mobile UI or a bottom tab bar.** The responsive work is *reflow and collapse* of the existing surface, not a parallel layout — one design language across devices.
- **Don't split the inline editor into a cluster of inline per-field mini-controls.** The grammar-parsing inline editor + live preview is already the calm quick-tweak surface; make `e`/`o` *discoverable* rather than adding chips and steppers to every row.

## 5. Recommended first sprint

The founder-approved starting point — all S, high-impact, north-star-safe, and each removes friction or stays invisible at rest:

1. **`?` shortcuts/help sheet** (+ capture-grammar section) — makes the whole app learnable. → Claude Design
2. **`⌘K` affordance in the QuickAdd bar** — unlocks the palette for pointer and touch. → Claude Design
3. **Fix `visibleTaskIds()`** to follow the rendered rows — the keyboard cursor finally matches the screen.
4. **Global `:focus-visible` ring** — WCAG 2.4.7, invisible to mouse users. → Claude Design
5. **`--faint` / light-accent contrast nudge** — WCAG 1.4.3, pure token change. → Claude Design
6. **Sync-health dot on the topbar button** — closes the silent-failure data-trust gap. → Claude Design
7. **Near-miss toasts** (unparseable date, tag-only add) + **Review/Share/Sync tooltips** — stop teaching users the app is unresponsive.
8. **Onboarding seed** replacing the dev backlog — a welcome instead of leaked internal data.

This sprint ships the two discoverability keystones, the highest-leverage keyboard and sync fixes, and both zero-clutter accessibility wins — setting up the mobile-reflow and search work (the meatier M/L tiers) as the next two sprints.