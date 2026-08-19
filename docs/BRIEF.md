# Rune

## 1. Product in one line

**Your todo list is one plain-text file; the web app is a beautiful, keyboard-fast lens on it, and an LLM is a first-class editor because the canonical artifact is already what an LLM reads and writes best.**

The five principles it lives by:

1. **The file is the product.** The app, the share link, and the AI are all views onto one `.rune` file. Anything the app can do, you can do with a text editor on a plane.
2. **One obvious way per concept.** Closed vocabularies, single-pass parse, no synonyms-by-accident. If two syntaxes could mean the same thing, one is wrong.
3. **Text is the interface; chrome is a guest.** Rows are text + a checkbox at rest. Structure comes from typography and whitespace, not boxes and badges.
4. **Power is one keystroke away, never on screen.** `Cmd+K` and the quick-add bar hold the power; the resting screen holds your work.
5. **No anxiety chrome.** No app badge counts, no "12 overdue!" banner, no streaks. Overdue is a quiet tint, not a red alarm.

## 2. The format — `*.rune`

**Core law: one task = one line. Children indent two spaces. Everything after the title is an order-independent, typed token you'd happily type by hand.** A `.rune` file is valid Markdown-ish text: it renders in any viewer, diffs cleanly in git, and an LLM emits it cold from the one header comment.

### Grammar (single pass, no backtracking)

```
<indent> "- [" <state> "] " <text> { " " <token> } [ " ^" <id> ]
```

`state` is one char from a closed set. `text` is the run of words before the first token. Each token is classified by its first character — no ambiguity, no lookahead:

| First char | Kind | Written as | Parses to |
|---|---|---|---|
| `( )` `x` `/` `-` `>` | state | `- [ ]` open · `- [x]` done · `- [/]` doing · `- [-]` cancelled · `- [>]` deferred | state char |
| `#` | tag / project (slash nests) | `#rune` · `#rune/release` | `[A-Za-z0-9_/-]+` |
| `@` | context (place / tool / person) | `@desk` · `@alice` | `[A-Za-z0-9_/-]+` |
| `!` | priority, count = level (1–3) | `!` `!!` `!!!` | level int; absent = none |
| `key:` | structured value (closed key set) | `due:2026-07-04` | `key`→value; quoted for spaces |
| `[[` | internal ref to another item | `[[t-7f3a]]` | target ID |
| `[` | external link / attachment | `[spec](./docs/spec.pdf)` | label + URL/path |
| `^` | stable ID (one per line, trailing) | `^t-7f3a` | the item's identity |
| `{>>` | inline review/AI comment (to `<<}`) | `{>> @ai[id=c-01 …]: … <<}` | one threaded comment |
| `{++ {-- {~~` | suggestion edit-op | `{++add++}` `{--del--}` `{~~old~>new~~}` | accept/reject diff |
| child `> ` | plain note (non-task child line) | `  > soft-start Monday` | note attached to parent |

**Reserved keys** (closed set): `due` `start` `scheduled` `done` `created` `after` `recur` `recur!` `file`. Every other `key:value` is **preserved-but-ignored** (todo.txt-style extensibility — the app and Claude Code never drop data they don't recognize).

### Decisions resolved (the dossier left these open)

1. **Priority = `!`-count, not `prio:high`.** Denser, sortable, glanceable, reads as "important." Text-first product; raw density wins. (Quick-add still accepts `p1`–`p3` as silent aliases for Todoist muscle memory.)
2. **Inline comments are CriticMarkup or `> ` child notes only — never inline `#`.** `#` is the tag sigil; the dossier's one real collision is `#tag` vs `# comment`. We also reject `//` as an inline-note delimiter: it reads as code and risks confusion against pasted paths. A quick aside is a `> ` child line; a review thread is CriticMarkup.
3. **No Org `<active>`/`[inactive]` dates.** The useful half is hard-vs-soft deadline, captured by `due:` (hard) vs `scheduled:`/`start:` (soft). One fewer concept.
4. **IDs: `^`-suffix, base36, `^t-` prefix, ≥4 chars.** Trailing, near-invisible in raw text. Assigned once at creation, never reused, never derived from text or position — this is what makes `after:`, `[[ ]]`, and AI comments survive reordering and reflow. The app stamps them; hand-editors may omit, and the app fills on next save.
5. **Dependencies: finish-to-start only** (`after:`). Every text format surveyed is FS-only; more is cruft. Multiple via comma: `after:t-a1b3,t-9k2`.
6. **Recurrence = Todoist's English grammar, stored verbatim**, expanded at runtime. `recur:"every other monday"` = fixed cadence from scheduled date; `recur!:"every 3 days"` = rolling cadence from completion. This `recur!` distinction is load-bearing UX that most clones get wrong.

### Dates

ISO `YYYY-MM-DD` is the **stored** form, always. Natural language (`due:tomorrow`, `due:"next monday"`) is accepted on *input* and normalized to ISO on save by chrono-node with `forwardDate:true` (a todo is virtually never due in the past) and the locale parser chosen from the user's region (for `3/4`-style ambiguity). `done:` is auto-stamped on check-off.

### Annotated example file — `work.rune`

```
<!-- rune v1 · ids:^t-xxxx · dates:ISO · comments:criticmarkup · anchor-by:id · reply-with:full-raw-doc -->
# Rune — Q3                                    @sam  updated:2026-06-30

- [/] Ship parser v1 #rune/release !!! due:2026-07-10 ^t-a1b2          ← doing, project-nested tag, highest prio, hard date
  > hard deadline is the demo; soft-start the grammar Monday            ← plain note (child, no checkbox)
  - [x] Survey existing formats ^t-a1b3 done:2026-06-30                 ← done sub-task, auto-stamped
  - [/] Draft grammar after:t-a1b3 ^t-a1b4 [grammar](./docs/grammar.md) ← depends-on a1b3; external link
    {>> @ai[id=c-01 ts=2026-06-30T10:00Z]: blocks [[t-a1b6]] — sequence it before review. <<}
  - [ ] Review with @alice after:t-a1b4 [[t-a1b2]] file:./specs/auth.pdf ^t-a1b5   ← context, dep, internal ref, attachment
- [ ] Ship web renderer #rune/release !!! after:t-a1b4 due:2026-07-11 ^t-a1b6
  - [ ] Raw text endpoint {++ + signed read scope ++} ^t-a1b7           ← suggestion edit-op, inline
- [ ] Pay AWS invoice !!! @finance recur!:"every month on the last" due:tomorrow ^t-a1b8   ← NL date → ISO on save
- [-] Evaluate emoji syntax #rune ^t-a1b9                              ← cancelled
  > dropped: bad for diff / regex / typing
- [>] Backlog cleanup #rune scheduled:2026-08-01 ^t-a1c0               ← deferred, soft date
```

### Why this is parser-trivial in TS

- Line regex: `/^(\s*)- \[(.)\] (.*?)(?:\s+\^(t-[a-z0-9]+))?\s*$/` → indent (depth = `indent.length / 2`), state char, body, id.
- Tokenize body on spaces (honoring `"…"` quotes); classify each token by first char per the table; `{>>`/`{++`/`{~~` consume to their close. Text = leading words until the first classified token.
- Single pass, no backtracking, no nesting parser. Unknown `key:value` round-trips untouched. Every construct is a short English-ish token, so an LLM emits it from the header alone.

## 3. Capture — the quick-add bar

The bar is the **primary surface**. Web-first, pinned to the top of every view, summonable anywhere with one key. **What you type is what gets stored** — the bar grammar *is* the file grammar.

### Token grammar

| Token | Meaning | Example |
|---|---|---|
| bare text | task title | `Pay AWS invoice` |
| `#tag` · `#proj/x` | tag / nested project | `#finance` `#rune/release` |
| `@context` | place / tool / person | `@finance` `@alice` |
| `!` `!!` `!!!` (or `p1`–`p3`) | priority low→highest | `!!!` |
| bare natural language | **date / time / recurrence — no sigil** | `friday` · `tomorrow 3pm` · `every other tue` |
| `due ` / `start ` (leading) | optional override: force next phrase through the date parser | `due april` (defeats "Email April") |
| `//notes` | description (consumed into the note, not the title) | `//bring cash` |
| pasted URL / dropped file | attachment / link, auto-detected | `https://…` → `[link](…)` |

**Dates do not require a sigil.** Every best-in-class parser (Todoist, Things, Akiflow, Fantastical) extracts dates from free-form text anywhere in the string; forcing `@fri` fights chrono-node and muscle memory. The leading `due `/`start ` override exists only to disambiguate month-name-as-noun.

### Live-parse UX

- As you type, `chrono.parse()` offsets drive **inline highlighting** (recognized spans dim into their rendered color in place). A single quiet preview line under the bar shows the resolved result: `Pay AWS invoice · #finance · !!! · repeats monthly (last day, from done)`.
- **The resolved date is always echoed in words** — `friday` → `Fri Jul 3` — so a locale-ambiguous `3/4` is caught *before* save. Inferred values (assumed PM) render in mute ink, not full ink.
- **Click-to-detach:** any parsed token demotes back to literal text on click. Global smart-parse off-switch. (The two escape hatches the research marks mandatory.)
- `forwardDate:true` always on. Recurrence runs through Rune's own small `every…`→RRULE grammar (chrono won't produce RRULEs — this is the project's known build cost, budget for it).

### Keyboard model

- `c` anywhere → focus bar. `Enter` adds + clears + keeps bar focused (rapid capture); `Shift-Enter` adds and opens the item; `Esc` blurs. Toast with **Undo** after every add.
- In the list: `j/k` or arrows move · `Space`/`Enter` toggle done · `Tab`/`Shift-Tab` indent/outdent (make sub-task / promote) · `Cmd+↑/↓` reorder (sequence) · `o` open detail · `Esc` collapse.
- `Cmd+K` is the one power surface: fuzzy, recency-ranked, shortcut-labeled on the right, list intentionally bleeding past the fold. Add task, set `after:`, link `[[ ]]`, share, "ask AI," switch theme — all here, never a toolbar.

## 4. Design language

**Direction: text-first / writerly, dark-first.** The thesis is "the file is the product," so the body type must *look* like trustworthy plain text, not a SaaS UI costumed as one.

### LOCKED (the visual designer must honor these)

- **Type system.** Body: **iA Writer Duo** (duospaced, IBM-Plex-derived; fallback IBM Plex Mono), so indentation lines up and metadata reads as metadata. Titles & chrome: **Inter** with `font-feature-settings: "cv05","ss03","calt","kern"`. **Tabular numerals on** everywhere dates, counts, and IDs appear.

  | Role | Size | Weight | LH | Tracking |
  |---|---|---|---|---|
  | Page title | 28 | 600 | 1.2 | −0.02em |
  | Section header | 20 | 600 | 1.3 | −0.01em |
  | **Task row (body)** | **15** | **400** | **1.45** | 0 |
  | Note / completed / meta | 13 | 400 | 1.4 | 0 |
  | Caption / keycap | 12 | 500 | 1.0 | 0 |

- **Spacing.** 4px base: `2 4 8 12 16 24 32 48 96`. Row vertical padding **8px** → row height ~**38px** (comfortable-dense: more on screen than Things, calmer than Linear's tightest). Checkbox→text gap 12px. Section gap 24–32px.
- **Color — dark-first, light a designed sibling (never auto-invert).**
  - Dark: Canvas `#07080a` · Surface `#0d0d0d` · Elevated `#121212` · Ink `#f4f4f6` · Body `#cdcdcd` · Mute `#9c9c9d` · Faint `#6a6b6c` · Hairline `rgba(255,255,255,0.08)`.
  - Light: Canvas `#ffffff` · Surface paper-warm `#fbfbfa` · Ink `#1a1a1a` (never `#000`) · Hairline `rgba(0,0,0,0.08)`.
- **One accent** `#57c1ff`, used for **exactly three things**: selection/active, the completion check, primary action. Soft fills at 15% alpha.
- **Radius/borders.** 6px rows/inputs, 10px palette/cards. 1px hairlines only — prefer dimming and space over boxes.
- **Anti-clutter techniques (non-negotiable):** empty-by-default fields (absent metadata renders *nothing*) · hover/`:focus-within` reveal for the only chrome that exists (reorder handle, date-edit, delete) · metadata as quiet inline mute-ink text, **not chips/pills** · hairlines and dimming over boxes (no card borders, no zebra, no persistent icons) · progressive disclosure by depth, not toggle · **no anxiety chrome** — overdue is a desaturated-red *ink tint on the date only*, never a badge or count.
- **Motion.** 120ms state · 180ms expand/collapse · 200ms list reflow; easing `cubic-bezier(0.2,0,0,1)`. One signature micro-delight: check-off draws the line-through left-to-right over ~160ms. Everything gated on `prefers-reduced-motion`; nothing animates at rest.

### OPEN (visual designer's call)

- The exact accent hue — `#57c1ff` (blue) vs a desaturated green `#59d499`; pick the one that reads calmest on `#07080a`.
- Whether `key:`/date/ID tokens get a subtle mono *tint* within the row, or just mute ink, to separate metadata without color noise.
- The `@ai` comment gutter hue (must be one distinct, quiet color, clearly not the accent).
- Light-mode warmth: clinical `#fbfbfa` vs a warmer paper closer to `#FBFAF7` — design and test light independently.
- Indentation rendering: hairline guide per 2-space level vs pure whitespace.

## 5. Views / information architecture

**Three views and one palette. Nothing more — fewer concepts is the philosophy.**

1. **Document** (default) — the file rendered top-to-bottom in file order, hierarchy by indentation. The single source of truth; editing here writes the file. This is where most people live.
2. **Today / Agenda** — a *derived filter*, not a place items live: `due:`/`scheduled:` ≤ today, plus overdue, flat, sorted priority then date. No duplicate state; same file.
3. **Sequence** — topologically orders by `after:` and surfaces **what's unblocked now**; blocked items dim with a quiet "waiting on Draft grammar" line. This is the payoff of a dependency-aware format — the thing airy todo apps structurally cannot do.

**Detail is a depth, not a fourth view:** `o` on a row pops a Things-style detail card and dims the list behind it (notes, dependency chain, attachments, comment threads). `Esc` collapses. Progressive disclosure by depth, never a panel-soup.

**Command palette (`Cmd+K`)** is the power surface across all three — not a view, the connective tissue that replaces every toolbar and menu.

Why nothing more: a todo file's hard problems are capture, sequencing, and dependencies — covered by Document + Sequence + the bar. Calendars, boards, and dashboards add concepts and chrome without adding truth the file doesn't already hold.

## 6. Sharing & AI comments

**One doc, two representations, one unguessable URL:**

```
Human view   https://rune.app/d/<docId>                          → styled HTML render
Raw view     https://rune.app/d/<docId>.txt   (or ?raw=1)        → text/plain, verbatim canonical bytes
Scoped raw   https://rune.app/d/<docId>.txt?items=t-a1b4,t-a1b6  → subset, for token budget
```

- `<docId>` is a 128-bit unguessable token = the capability. The raw link is a **signed, read-only scope**, distinct from any write capability.
- The raw endpoint returns the **exact canonical bytes** the renderer consumes — `Content-Type: text/plain; charset=utf-8`, `Content-Disposition: inline`, no HTML, no truncation. This is the URL you hand an LLM (or a browsing LLM fetches).
- The file's top-line header comment self-briefs a cold model on IDs, comment format, and reply mode — no system prompt needed:
  `<!-- rune v1 · ids:^t-xxxx · comments:criticmarkup · anchor-by:id · reply-with:full-raw-doc -->`

**Authoring & anchoring comments.** Comments are CriticMarkup blocks anchored to stable `^ids`, **never line numbers** (LLMs reflow text and renumber freely; line anchors orphan — the GitHub line-drift failure). Each block carries a metadata head CriticMarkup itself lacks:

```
{>> @ai[id=c-01 ts=2026-06-30T10:00Z]: blocks [[t-a1b6]] — sequence before review. <<}
{>> @sam[id=c-02 reply=c-01]: agreed, reordered. <<}
{>> @ai[id=c-03 reply=c-01 resolved]: acknowledged. <<}
```

`@author` = attribution (`@ai` distinguished from humans); `id` + `reply` = a threaded tree; `resolved` collapses. Each block stays within a single item (CriticMarkup's single-block rule). Suggestions use native edit-ops (`{++ ++}` / `{-- --}` / `{~~ ~>~~}`) for free accept/reject, with a trailing `{>> @ai[…]: rationale <<}` for the why.

**Rendering (Google-Docs duality, uncluttered).** The item line stays clean text. Comments collapse to a small **count badge**; clicking expands a **right-margin gutter card stack**, threaded by `id`/`reply`, `@ai` color-keyed and visually distinct from humans, **resolved threads hidden by default**. Suggestion ops render inline (insert underlined, delete struck) with ✓/✗ controls. The reading text never moves; discussion lives in the margin.

**Round-trip, two paths, default to paste:**

1. **Paste round-trip (default, zero integration, provider-agnostic).** The LLM re-emits the *whole doc* with CriticMarkup inserted; the user pastes it back; Rune reconciles **by `^id`, not position**, and **validates that every non-annotation byte is unchanged** before accepting, previewing as a diff. The ID-reconciliation + unchanged-bytes guard is mandatory, not optional — it's what protects weaker models from whole-doc corruption.
2. **API write-back (power path).** The LLM returns JSON `[{itemId, kind, anchor, body, author, ts}]` validated against a schema; the backend writes each as a CriticMarkup span at the right item. No whole-doc reproduction, no corruption risk.

**Claude Code uses the same contract** as a browsing LLM: point it at the file (or the raw URL), ask for a review, get CriticMarkup back, apply via the same byte-validated merge. One contract for humans, the web app, and Claude Code alike.

## 7. Architecture & stack

**The reconciliation problem:** a plain-text file on disk must stay canonical while a hosted web app edits and shares it. Rune resolves it by making the **file the source of truth and the server a cache + capability-granter, never the owner.**

- **Local-canonical, hosted-projected.** The `.rune` file lives wherever the user keeps it (a git repo, a synced folder). The web app reads and writes *that file's bytes*. A shared doc is a **published snapshot + a live binding back to the source**: the server stores the latest bytes to serve `/.txt` and the rendered view, but every edit is expressed as a byte-level patch the file can replay. Conflicts reconcile **by `^id`**, not line position — the same property that makes AI merges safe makes sync safe.
- **Editing model.** The web editor parses → edits structurally → re-serializes to canonical bytes, then writes back through whichever source adapter is configured: local filesystem (via a small local agent / the File System Access API), a git remote (commit on change), or Rune's own hosted store for users who don't want a file on disk. The *format* is identical across all three; only the storage adapter differs.
- **Recommended TypeScript stack:**
  - **Parser/serializer:** hand-rolled single-pass tokenizer in plain TS (the regex is trivial; no parser-generator). The canonical model is a pure `Doc → Item[]` tree with byte-offset preservation for unknown tokens.
  - **Dates:** `chrono-node` for NL extraction (offsets for highlighting, `forwardDate`, per-locale parsers); `date-fns` (or Luxon) for formatting/arithmetic/timezones; a small in-house `every…`→RRULE grammar.
  - **App:** React + Vite, TanStack Router. State as the parsed doc tree; renders are pure functions of it.
  - **Editor surface:** CodeMirror 6 for the raw/source mode and live-parse highlighting (it gives token decorations + offsets cheaply); a rendered-view layer on top for the Things-style cards and gutter comments.
  - **Comments/suggestions:** a CriticMarkup parse/render pass (the `@author[...]` head is Rune's own extension — write that layer; don't expect an off-the-shelf renderer to know it).
  - **Server:** a thin TS service (Hono or Fastify) for share links, the `/.txt` raw endpoint (signed read scope), snapshot storage, and the JSON write-back API. No heavy backend; the file is the database.
- **How Claude Code points at it.** The `.rune` file *is* the API — no integration layer:
  - Point `claude` at the repo holding `work.rune`. The header comment + a one-page `RUNE.md` grammar make the model fluent immediately.
  - It reads/edits with ordinary Read/Edit tools; the line-oriented, single-pass format is diff-clean precisely so an agent's edits are reviewable in `git diff`.
  - It references and reorders items by `^t-id`; `after:` and `[[ ]]` survive its edits because nothing is position-dependent. It assigns new IDs in the same base36 shape or leaves them blank for the app to stamp.
  - It authors review notes as `{>> @ai[…]: … <<}` and suggestions as edit-ops — the same artifact a human pastes back from chat, written directly to the file, rendered identically in the web app with zero extra plumbing.

## 8. Build plan

Smallest real thing first; each milestone ships something usable.

- **M0 — The format is real.** Parser + serializer in TS; round-trips the annotated example file byte-for-byte (unknown `key:value` preserved). A `.rune` file + `RUNE.md` grammar. *This is the spine; nothing else matters until it's solid.*
- **M1 — Read-only lens.** Render a local `.rune` file as the Document view (dark theme, locked type/spacing). No editing yet. Proves the typographic thesis on a real file.
- **M2 — Edit + capture.** The quick-add bar with chrono-node live-parse, click-to-detach, and the keyboard model. Edits write back to the local file (File System Access API). Check-off, indent/outdent, reorder. This is the usable MVP for a single user on their own machine.
- **M3 — Today + Sequence.** The two derived views; `after:`/`[[ ]]` dependency resolution and the unblocked-now ordering. Recurrence (`every…`→RRULE) lands here — budget for it; it's the biggest single risk.
- **M4 — Share link + raw endpoint.** Hosted snapshot, `/d/<docId>` render, `/.txt` signed read-only raw, scoped `?items=`. Self-briefing header. Now an LLM can read your list.
- **M5 — AI comments round-trip.** CriticMarkup parse/render, gutter cards, threading, resolve. Paste round-trip with `^id` reconciliation + unchanged-bytes validation. Suggestion accept/reject.
- **M6 — Power round-trips.** JSON write-back API; Claude Code documented as a first-class author; git-remote storage adapter alongside local + hosted.

## 9. Open questions for the visual design pass

- Accent hue: blue `#57c1ff` vs green `#59d499` on `#07080a` — which reads calmest?
- Do metadata tokens (`#tag`, `due:`, `^id`) get a subtle mono tint inside the row, or just mute ink?
- The single `@ai`-comment gutter hue (quiet, clearly not the accent).
- Light mode: clinical `#fbfbfa` vs warmer paper — design and test independently, not by inversion.
- Indentation: hairline depth-guides vs pure whitespace.
- Does the Sequence view need a small visual dependency chain, or is dimming + a "waiting on…" line enough?
- The one micro-delight: is the left-to-right strike-through right, or is there something quieter?
- Empty states: confirm one calm line + one keyboard hint ("Press c to add a task"), no illustration.

## 10. Project name — decided: **Rune**

Chosen name: **Rune**, file extension **`.rune`**. (The synthesis agent's first draft reused "Crow", but that name already belongs to the Marmalade/Cactus Risk Studio rebuild, so it was rejected to avoid the collision.)

Why Rune holds up: a rune is a terse mark that carries meaning — exactly one per line — which is the whole thesis of the format. Short, distinctive, an unused namespace among the existing projects, and a clean file extension.

Alternates considered and set aside: **Cairn** (markers left on a path for whoever follows — richest meaning, but longer to type), **Jot** (leans into effortless capture, but generic), **Trail** (pairs with the Sequence view, but generic).