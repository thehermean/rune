// Notes collection — a second content type alongside the single synced doc.
//
// Each note is a real Markdown file under $RUNE_DATA_DIR/notes/<folder…>/<id>.md
// (folders = directories), with a small frontmatter block carrying the stable
// id, pinned flag, and created/updated stamps so renames/moves never break
// links. The web app is a lens; the .md files stay canonical and back up as a
// plain folder — the same local-canonical principle as the .rune doc.
//
// A derived MANIFEST (title/snippet/tags/links per note) is built by scanning
// the dir on demand — no separate index to keep in sync. Writes are atomic
// (temp + rename); saves are conditional on the note's `updated` stamp (mirrors
// server/doc.ts) so a concurrent edit 409s instead of silently clobbering.
//
// Auth mirrors /api/doc: open on a trusted tailnet (RUNE_OPEN_SYNC=1), else
// RUNE_TOKEN bearer-gated. Path segments are validated so a hostile id/folder
// can never escape the notes root.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync,
  readdirSync, statSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { Hono, type Context } from 'hono';
import { checkToken } from './auth';
import { dataDir } from './config';

const TRASH = '.trash';
const MAX_BYTES = 2 * 1024 * 1024; // 2MB per note.
const ID_RE = /^n_[A-Za-z0-9_-]{8,}$/;

function notesRoot(): string { return join(dataDir(), 'notes'); }

export interface NoteMeta {
  id: string;
  folder: string;   // '' = root; POSIX-style '/' separators
  title: string;
  snippet: string;
  pinned: boolean;
  created: string;
  updatedAt: string;
  tags: string[];
  links: string[];
}
export interface NoteFile {
  id: string;
  folder: string;
  markdown: string; // body WITHOUT frontmatter
  pinned: boolean;
  created: string;
  updatedAt: string;
}

// --- path safety ----------------------------------------------------------
/** Normalise + validate a folder path; null if it tries to escape the root. */
function safeFolder(input: unknown): string | null {
  if (input == null || input === '') return '';
  if (typeof input !== 'string') return null;
  const segs = input.split('/').filter((s) => s !== '');
  for (const s of segs) {
    if (s === '.' || s === '..' || s.startsWith('.')) return null;
    if (s.includes('\0') || s.includes(sep) || s.includes('/')) return null;
    if (s.length > 64) return null;
  }
  return segs.join('/');
}

// --- frontmatter ----------------------------------------------------------
interface FM { id: string; pinned: boolean; created: string; updated: string }

function parseNote(raw: string): { fm: Partial<FM>; body: string } {
  if (!raw.startsWith('---\n')) return { fm: {}, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { fm: {}, body: raw };
  const head = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const fm: Partial<FM> = {};
  for (const line of head.split('\n')) {
    const m = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'id') fm.id = v;
    else if (k === 'created') fm.created = v;
    else if (k === 'updated') fm.updated = v;
    else if (k === 'pinned') fm.pinned = v === 'true';
  }
  return { fm, body };
}

function serializeNote(fm: FM, body: string): string {
  return `---\nid: ${fm.id}\npinned: ${fm.pinned}\ncreated: ${fm.created}\nupdated: ${fm.updated}\n---\n${body}`;
}

// --- derivations ----------------------------------------------------------
function deriveTitle(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    return t.replace(/^#{1,6}\s+/, '').replace(/[*_`~]/g, '').trim() || 'Untitled';
  }
  return 'Untitled';
}
function deriveSnippet(body: string): string {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const rest = lines.slice(1).join(' ').replace(/[#*_`~>[\]]/g, '').trim();
  return rest.slice(0, 140);
}
function extractTags(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/(?:^|\s)#([a-z0-9][a-z0-9_/-]*)/gi)) out.add(m[1].toLowerCase());
  return [...out];
}
function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) out.add(m[1].trim());
  return [...out];
}

// --- filesystem walk ------------------------------------------------------
function* walkNotes(): Generator<{ id: string; folder: string; abs: string }> {
  const root = notesRoot();
  if (!existsSync(root)) return;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === TRASH) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const id = e.name.slice(0, -3);
        if (!ID_RE.test(id)) continue;
        const folder = relative(root, dir).split(sep).join('/');
        yield { id, folder, abs };
      }
    }
  }
}

function findNoteAbs(id: string): { abs: string; folder: string } | undefined {
  if (!ID_RE.test(id)) return undefined;
  for (const n of walkNotes()) if (n.id === id) return { abs: n.abs, folder: n.folder };
  return undefined;
}

function writeAtomic(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, abs);
}

// --- collection operations ------------------------------------------------
export function listNotes(): NoteMeta[] {
  const out: NoteMeta[] = [];
  const now = new Date().toISOString();
  for (const { id, folder, abs } of walkNotes()) {
    try {
      const { fm, body } = parseNote(readFileSync(abs, 'utf-8'));
      out.push({
        id, folder,
        title: deriveTitle(body),
        snippet: deriveSnippet(body),
        pinned: fm.pinned ?? false,
        created: fm.created ?? now,
        updatedAt: fm.updated ?? now,
        tags: extractTags(body),
        links: extractLinks(body),
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) =>
    (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) ||
    (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

export function searchNotes(query: string): NoteMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return listNotes();
  const out: NoteMeta[] = [];
  const now = new Date().toISOString();
  for (const { id, folder, abs } of walkNotes()) {
    try {
      const { fm, body } = parseNote(readFileSync(abs, 'utf-8'));
      const title = deriveTitle(body);
      const tags = extractTags(body);
      const bodyLc = body.toLowerCase();
      const bAt = bodyLc.indexOf(q);
      if (!title.toLowerCase().includes(q) && bAt === -1 && !tags.some((t) => t.includes(q))) continue;
      const snippet = bAt >= 0
        ? body.slice(Math.max(0, bAt - 30), bAt + 90).replace(/\s+/g, ' ').trim()
        : deriveSnippet(body);
      out.push({
        id, folder, title, snippet, pinned: fm.pinned ?? false,
        created: fm.created ?? now, updatedAt: fm.updated ?? now, tags, links: extractLinks(body),
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) =>
    (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) ||
    (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

export function getNote(id: string): NoteFile | undefined {
  const found = findNoteAbs(id);
  if (!found) return undefined;
  const { fm, body } = parseNote(readFileSync(found.abs, 'utf-8'));
  const now = new Date().toISOString();
  return {
    id, folder: found.folder, markdown: body,
    pinned: fm.pinned ?? false, created: fm.created ?? now, updatedAt: fm.updated ?? now,
  };
}

export function createNote(folderInput: unknown, title: unknown): NoteFile | null {
  const folder = safeFolder(folderInput);
  if (folder === null) return null;
  const id = `n_${nanoid(12)}`;
  const now = new Date().toISOString();
  const t = typeof title === 'string' ? title.trim() : '';
  const body = t ? `# ${t}\n\n` : '';
  writeAtomic(join(notesRoot(), folder, `${id}.md`), serializeNote({ id, pinned: false, created: now, updated: now }, body));
  return { id, folder, markdown: body, pinned: false, created: now, updatedAt: now };
}

export type SaveResult =
  | { ok: true; updatedAt: string }
  | { ok: false; conflict: true; updatedAt: string; markdown: string }
  | { ok: false; notFound: true };

export function saveNote(id: string, markdown: string, base?: string): SaveResult {
  const found = findNoteAbs(id);
  if (!found) return { ok: false, notFound: true };
  const { fm, body } = parseNote(readFileSync(found.abs, 'utf-8'));
  const curUpdated = fm.updated ?? '';
  if (base !== undefined && base !== '' && curUpdated !== '' && curUpdated !== base) {
    return { ok: false, conflict: true, updatedAt: curUpdated, markdown: body };
  }
  const updated = new Date().toISOString();
  writeAtomic(found.abs, serializeNote({
    id, pinned: fm.pinned ?? false, created: fm.created ?? updated, updated,
  }, markdown));
  return { ok: true, updatedAt: updated };
}

export function setPinned(id: string, pinned: boolean): boolean {
  const found = findNoteAbs(id);
  if (!found) return false;
  const { fm, body } = parseNote(readFileSync(found.abs, 'utf-8'));
  const updated = new Date().toISOString();
  writeAtomic(found.abs, serializeNote({ id, pinned, created: fm.created ?? updated, updated }, body));
  return true;
}

export function moveNote(id: string, folderInput: unknown): boolean {
  const found = findNoteAbs(id);
  if (!found) return false;
  const folder = safeFolder(folderInput);
  if (folder === null) return false;
  const dest = join(notesRoot(), folder, `${id}.md`);
  if (dest === found.abs) return true;
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(found.abs, dest);
  return true;
}

/** Move a note into .trash and return its full content (a restore ticket). */
export function trashNote(id: string): NoteFile | undefined {
  const note = getNote(id);
  const found = findNoteAbs(id);
  if (!note || !found) return undefined;
  const dest = join(notesRoot(), TRASH, `${id}.md`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(found.abs, dest);
  return note;
}

/** Re-create a note from a trash ticket (or from anywhere the client kept it). */
export function restoreNote(note: NoteFile): boolean {
  const folder = safeFolder(note.folder);
  if (folder === null || !ID_RE.test(note.id)) return false;
  const trashed = join(notesRoot(), TRASH, `${note.id}.md`);
  const dest = join(notesRoot(), folder, `${note.id}.md`);
  const updated = new Date().toISOString();
  if (existsSync(trashed)) {
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(trashed, dest);
    return true;
  }
  writeAtomic(dest, serializeNote(
    { id: note.id, pinned: note.pinned, created: note.created, updated },
    note.markdown,
  ));
  return true;
}

// --- HTTP (mounted at /api/notes) -----------------------------------------
function authed(c: Context): Response | null {
  const expected = process.env.RUNE_TOKEN && process.env.RUNE_TOKEN !== '' ? process.env.RUNE_TOKEN : undefined;
  const header = c.req.header('authorization');
  const presented = header && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (process.env.RUNE_OPEN_SYNC === '1') {
    if (presented !== '' && !(expected && checkToken(header, expected))) return c.json({ error: 'unauthorized' }, 401);
    return null;
  }
  if (!expected) return c.json({ error: 'sync not configured' }, 503);
  if (!checkToken(header, expected)) return c.json({ error: 'unauthorized' }, 401);
  return null;
}

const notesApp = new Hono();

notesApp.get('/', (c) => authed(c) ?? c.json({ notes: listNotes() }));

notesApp.post('/', async (c) => {
  const denied = authed(c); if (denied) return denied;
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { /* empty body ok */ }
  const note = createNote(body.folder, body.title);
  return note ? c.json(note, 201) : c.json({ error: 'invalid folder' }, 400);
});

notesApp.get('/search', (c) => authed(c) ?? c.json({ notes: searchNotes(c.req.query('q') ?? '') }));

notesApp.get('/:id', (c) => {
  const denied = authed(c); if (denied) return denied;
  const note = getNote(c.req.param('id'));
  return note ? c.json(note) : c.json({ error: 'not found' }, 404);
});

notesApp.put('/:id', async (c) => {
  const denied = authed(c); if (denied) return denied;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object' || typeof (body as { markdown?: unknown }).markdown !== 'string') {
    return c.json({ error: 'expected { markdown: string }' }, 400);
  }
  const markdown = (body as { markdown: string }).markdown;
  if (Buffer.byteLength(markdown, 'utf8') > MAX_BYTES) return c.json({ error: 'note too large' }, 413);
  const bodyBase = (body as { baseUpdatedAt?: unknown }).baseUpdatedAt;
  const base = c.req.header('if-match') ?? (typeof bodyBase === 'string' ? bodyBase : undefined);
  const r = saveNote(c.req.param('id'), markdown, base);
  if (r.ok) return c.json({ ok: true, updatedAt: r.updatedAt });
  if ('notFound' in r) return c.json({ error: 'not found' }, 404);
  return c.json({ error: 'conflict', updatedAt: r.updatedAt, markdown: r.markdown }, 409);
});

notesApp.delete('/:id', (c) => {
  const denied = authed(c); if (denied) return denied;
  const note = trashNote(c.req.param('id'));
  return note ? c.json({ ok: true, note }) : c.json({ error: 'not found' }, 404);
});

notesApp.post('/:id/restore', async (c) => {
  const denied = authed(c); if (denied) return denied;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const note = (body as { note?: NoteFile }).note;
  if (!note || typeof note.id !== 'string') return c.json({ error: 'expected { note }' }, 400);
  return restoreNote(note) ? c.json({ ok: true }) : c.json({ error: 'invalid note' }, 400);
});

notesApp.post('/:id/move', async (c) => {
  const denied = authed(c); if (denied) return denied;
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { /* */ }
  return moveNote(c.req.param('id'), body.folder) ? c.json({ ok: true }) : c.json({ error: 'not found or invalid' }, 400);
});

notesApp.post('/:id/pin', async (c) => {
  const denied = authed(c); if (denied) return denied;
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { /* */ }
  return setPinned(c.req.param('id'), body.pinned === true) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

// --- attachments (bytes) — mounted at /api/notes-attachments -------------
function attachDir(): string { return join(dataDir(), 'notes-attachments'); }
const ATTACH_RE = /^[a-f0-9]{16,}\.[a-z0-9]{1,8}$/i;
const MAX_ATTACH = 10 * 1024 * 1024;
const CONTENT_TYPE: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
};

const attachmentsApp = new Hono();

attachmentsApp.post('/', async (c) => {
  const denied = authed(c);
  if (denied) return denied;
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'expected a file field' }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength > MAX_ATTACH) return c.json({ error: 'attachment too large' }, 413);
  const ext = (file.name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 20);
  const name = `${hash}.${ext}`;
  const dir = attachDir();
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, name);
  if (!existsSync(abs)) {
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, abs);
  }
  return c.json({ url: `/api/notes-attachments/${name}`, name: file.name });
});

attachmentsApp.get('/:name', (c) => {
  // Content-addressed by hash, tailnet-only -> served without a token (an
  // <img src> can't send the bearer). Upload stays authed.
  const name = c.req.param('name');
  if (!ATTACH_RE.test(name)) return c.json({ error: 'bad name' }, 400);
  const abs = join(attachDir(), name);
  if (!existsSync(abs)) return c.json({ error: 'not found' }, 404);
  const ext = name.split('.').pop() as string;
  const bytes = readFileSync(abs);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

export { notesApp, attachmentsApp };
