# Rune

**Live: [rune.hermean.org](https://rune.hermean.org)**

Your todo list is **one plain-text file**. The web app, the share link, and any
LLM are just lenses on it. Anything the app can do, you can do with a text editor
on a plane.

- **Format & contract:** [`RUNE.md`](./RUNE.md) — the `.rune` grammar, fluent in one page.
- **Full product/design brief:** [`docs/BRIEF.md`](./docs/BRIEF.md).
- **A real file:** [`examples/work.rune`](./examples/work.rune).

## Status

**M0–M6 built** (git adapter aside) — 100 tests green, clean typecheck, successful web build.

- **M0 — format core.** Single-pass parser/serializer, byte-for-byte round-trip
  (unknown `key:value` preserved), structured model.
- **M1/M2 — web app + full editing.** Vite + React, the locked design tokens, the
  Document view, the quick-add bar (chrono-node live parse), check-off / indent /
  reorder, **delete, inline edit, sub-task break-out, set date/priority/tags/deps,
  undo/redo**, and File System Access persistence.
- **M3 — views + recurrence.** Today (agenda) and Sequence (dependency-ordered,
  "unblocked now") views; an English→RRULE recurrence engine wired to spawn the
  next occurrence on completion (`recur:` fixed cadence, `recur!:` rolling, with
  month-end clamping).
- **M4 — sharing.** A Hono service (publish → unguessable URL, `/d/:id.txt` raw
  endpoint returning the **exact canonical bytes**, scoped `?items=`, HTML render)
  **and an in-app Share dialog** (Vite-proxied to the server, copyable links).
- **M5 — AI comments.** CriticMarkup parsing + a threaded comment gutter, a
  byte-validated `^id`-reconciled paste-merge that **rejects any tampering**
  (verified: changed title → HTTP 422), and an **in-app Review modal** that
  re-validates against the live doc before applying.
- **M6 — power round-trips.** JSON write-back API on the server; the `.rune` file
  is the Claude Code contract (`RUNE.md`).
- **Extras:** a raw **Source view** (bound to `setText`), and **attachments**
  (drop/paste a file or URL → parens-safe `[label](target)`, list/remove/open).

Not built: the **git-remote storage adapter** (M6 stretch — a repo/Claude-Code
concern; the app already saves to a real `.rune` file you keep in a git repo).
Still pending: the **Claude Design visual pass** (`docs/BRIEF.md §4`/`§9`).

## Run

```sh
pnpm install
pnpm dev          # the web app (Vite dev server, with /api + /d proxied to :8787)
pnpm serve:api    # the share server on http://localhost:8787
pnpm test         # 100 tests (core + recurrence + criticmarkup + reconcile + edit + attach + server)
pnpm typecheck
pnpm build:web    # production build -> dist/web
```

## Library shape

```ts
import { parse, serialize, tasks, findById, getKey, afterOf } from './src/index';

const doc = parse(text);          // text -> structured Doc (lossless)
serialize(doc) === text;          // byte-for-byte for canonical input
const t = findById(doc, 't-a1b2');
t.state;                          // 'doing'
getKey(t, 'due');                 // '2026-07-10'
afterOf(t);                       // ['t-a1b...'] dependency ids
```

---

Rune is day 7 of [The Hermean](https://hermean.org), 88 projects in 88 days.
