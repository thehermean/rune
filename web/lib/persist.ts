// Persistence adapter.
//
// The .rune file is the source of truth (BRIEF §7). When the browser supports
// the File System Access API we hold a live handle and write the canonical
// bytes straight back to the user's file. Otherwise we fall back to localStorage
// plus an explicit download so the user can still keep their file on disk.
//
// This module deliberately knows nothing about the Doc model — it moves bytes.

const LS_KEY = 'rune:doc';
const LS_NAME = 'rune:fileName';

// --- File System Access API typings (not in lib.dom for all targets) ---------

interface FsWritable {
  write(data: string | Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
}
/** The permission surface File System Access handles expose. Optional because
 *  older implementations (and our in-memory test mocks) omit it. */
interface FsPermissioned {
  queryPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
interface FsFileHandle extends FsPermissioned {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FsWritable>;
}
interface FsDirHandle extends FsPermissioned {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  values(): AsyncIterableIterator<FsFileHandle | FsDirHandle>;
}
interface OpenPickerOptions {
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  multiple?: boolean;
}
interface FsWindow {
  showOpenFilePicker?: (opts?: OpenPickerOptions) => Promise<FsFileHandle[]>;
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirHandle>;
}

function fsWindow(): FsWindow {
  return window as unknown as FsWindow;
}

export function supportsFileSystemAccess(): boolean {
  return typeof fsWindow().showOpenFilePicker === 'function';
}

/** Directory access (showDirectoryPicker) is Chromium-only today. When present
 *  we can store attachment BYTES next to the .rune file, not just a reference. */
export function supportsDirectoryAccess(): boolean {
  return typeof fsWindow().showDirectoryPicker === 'function';
}

const RUNE_PICKER: OpenPickerOptions = {
  types: [{ description: 'Rune file', accept: { 'text/plain': ['.rune', '.txt', '.md'] } }],
  multiple: false,
};

export interface OpenedFile {
  handle: FsFileHandle | null;
  name: string;
  text: string;
}

/** Open a real .rune file via the picker and keep the handle for write-back.
 *  Returns null if the user cancels. Throws only on a genuine read error. */
export async function openWithPicker(): Promise<OpenedFile | null> {
  const w = fsWindow();
  if (!w.showOpenFilePicker) return null;
  let handles: FsFileHandle[];
  try {
    handles = await w.showOpenFilePicker(RUNE_PICKER);
  } catch (err) {
    // AbortError = user cancelled; swallow it.
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
  const handle = handles[0];
  if (!handle) return null;
  const file = await handle.getFile();
  const text = await file.text();
  return { handle, name: handle.name, text };
}

/** Read a File chosen via a hidden <input type=file> (fallback open path). */
export async function readInputFile(file: File): Promise<OpenedFile> {
  const text = await file.text();
  return { handle: null, name: file.name, text };
}

/** Write canonical bytes back through a live handle. Throws if the write fails. */
export async function writeHandle(handle: FsFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/**
 * Ensure we hold readwrite permission on a handle before writing to it. A handle
 * restored from IndexedDB across a reload starts in the `prompt` state, and
 * re-granting requires a user gesture — so:
 *   - `request: false` (a background/debounced write) only proceeds when
 *     permission is ALREADY granted; otherwise it returns false and the caller
 *     surfaces a quiet "Reconnect file" affordance.
 *   - `request: true` (a button click carrying user activation) may prompt.
 * Handles with no permission API (older browsers, test mocks) are treated as
 * granted — the write itself will throw if it truly isn't allowed.
 */
export async function ensureWritePermission(
  handle: FsFileHandle | FsDirHandle,
  request: boolean,
): Promise<boolean> {
  try {
    if (typeof handle.queryPermission !== 'function') return true;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    if (!request || typeof handle.requestPermission !== 'function') return false;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

// --- persisted file handles (IndexedDB) --------------------------------------
//
// File System Access handles are structured-cloneable, so we stash the live
// handle in IndexedDB and restore it after a reload. This keeps the "write back
// to the open file" binding alive across sessions (permission is re-checked
// lazily on the next write). Feature-detected so non-IDB environments (and the
// Node test runner) degrade to a no-op rather than throwing.

const IDB_NAME = 'rune';
const IDB_STORE = 'handles';
const IDB_KEY = 'current';

export interface StoredHandles {
  fileHandle: FsFileHandle | null;
  dirHandle: FsDirHandle | null;
  fileName: string | null;
}

function idbFactory(): IDBFactory | null {
  try {
    return typeof indexedDB !== 'undefined' ? indexedDB : null;
  } catch {
    return null;
  }
}

function openIdb(): Promise<IDBDatabase | null> {
  const factory = idbFactory();
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(IDB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** Persist the current file/dir handle (or clear it when both are null). */
export async function saveHandles(handles: StoredHandles): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      if (!handles.fileHandle && !handles.dirHandle) store.delete(IDB_KEY);
      else store.put(handles, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

/** Restore the persisted handles, or null when none/unavailable. */
export async function loadHandles(): Promise<StoredHandles | null> {
  const db = await openIdb();
  if (!db) return null;
  const result = await new Promise<StoredHandles | null>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as StoredHandles | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  db.close();
  return result;
}

// --- directory-backed storage (attachments live next to the .rune file) ------

export interface OpenedDir {
  dirHandle: FsDirHandle;
  fileHandle: FsFileHandle;
  name: string;
  /** Text of the existing .rune in the folder, or null when a fresh file was
   *  created (the caller keeps its current text and saves it into the new file). */
  text: string | null;
}

/** Open a FOLDER (read-write) that holds the .rune file. Uses the first existing
 *  *.rune in it, else creates todo.rune. Returns null if the user cancels. */
export async function openDirectory(): Promise<OpenedDir | null> {
  const w = fsWindow();
  if (!w.showDirectoryPicker) return null;
  let dir: FsDirHandle;
  try {
    dir = await w.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
  let found: FsFileHandle | null = null;
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && entry.name.endsWith('.rune')) {
      found = entry;
      break;
    }
  }
  if (found) {
    const file = await found.getFile();
    return { dirHandle: dir, fileHandle: found, name: found.name, text: await file.text() };
  }
  const created = await dir.getFileHandle('todo.rune', { create: true });
  return { dirHandle: dir, fileHandle: created, name: 'todo.rune', text: null };
}

/** True if `dir` already has a file named `name` in it. */
async function fileExists(dir: FsDirHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Pick a non-clobbering name in `dir`: "a.pdf" -> "a-1.pdf" if taken. */
async function uniqueFileName(dir: FsDirHandle, name: string): Promise<string> {
  if (!(await fileExists(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!(await fileExists(dir, candidate))) return candidate;
  }
  return name; // give up after 1000 — overwrite (practically unreachable)
}

/** Copy a file's BYTES into <dir>/attachments/<unique-name>; returns the relative
 *  reference ("attachments/<name>") to store in the .rune line. */
export async function writeAttachment(dir: FsDirHandle, file: File): Promise<string> {
  const attachDir = await dir.getDirectoryHandle('attachments', { create: true });
  const finalName = await uniqueFileName(attachDir, file.name);
  const handle = await attachDir.getFileHandle(finalName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
  return `attachments/${finalName}`;
}

/** Read an attachment back from the folder by its stored (possibly %-encoded)
 *  relative path. Returns null if missing. */
export async function readAttachment(dir: FsDirHandle, relPath: string): Promise<File | null> {
  const parts = relPath
    .replace(/^\.?\//, '')
    .split('/')
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  let d = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    try {
      d = await d.getDirectoryHandle(parts[i]);
    } catch {
      return null;
    }
  }
  try {
    const fh = await d.getFileHandle(parts[parts.length - 1]);
    return await fh.getFile();
  } catch {
    return null;
  }
}

/** Trigger a browser download of the canonical bytes (fallback save path). */
export function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'work.rune';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- localStorage cache ------------------------------------------------------

/** Write the canonical bytes to localStorage. Returns false when storage is
 *  unavailable (private mode) or full (quota) so the caller can surface it —
 *  the in-memory doc remains canonical for the session either way. */
export function saveLocal(text: string, fileName: string | null): boolean {
  try {
    localStorage.setItem(LS_KEY, text);
    if (fileName) localStorage.setItem(LS_NAME, fileName);
    return true;
  } catch {
    return false;
  }
}

export function loadLocal(): { text: string; fileName: string | null } | null {
  try {
    const text = localStorage.getItem(LS_KEY);
    if (text === null) return null;
    return { text, fileName: localStorage.getItem(LS_NAME) };
  } catch {
    return null;
  }
}

/** Fetch the seed file Vite serves from web/public on first run. */
export async function fetchSeed(): Promise<string | null> {
  try {
    const res = await fetch('/work.rune');
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// --- cross-device sync (same-origin /api/doc, bearer token) ------------------
//
// A tiny last-write-wins sync layer: the server holds ONE canonical .rune doc,
// gated by a shared bearer token. Paste the same token on each device to share
// one list. These two functions only move bytes — the store decides when to pull
// (server is source of truth on load) and debounces pushes on edit.
//
// Empty-token (trusted-network) requests: an empty `token` means "open server,
// no bearer" — we OMIT the Authorization header entirely rather than send a
// meaningless `Bearer ` with nothing after it. This is also the discovery probe:
// GET with no token returns the doc on an open server, or 401 when a token is
// required.

/** Build the request headers, omitting Authorization for an empty token. */
function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Sentinel precondition value meaning "this write must ONLY land on a server that
 * has no doc yet" — the precondition a never-synced device sends when seeding a
 * shared server. It is deliberately distinguishable from BOTH a real `updatedAt`
 * (always an ISO timestamp, never this literal) AND the absence of a precondition
 * (an empty/omitted value). The server (`server/doc.ts`) mirrors this literal and
 * 409s an expect-empty write whenever any doc already exists. Sent as both an
 * `If-Match` header and a `baseUpdatedAt` body field so a keepalive flush (which
 * can drop headers) still carries it.
 */
export const EXPECT_EMPTY_PRECONDITION = 'expect-empty';

/** The current doc on the server, or null when there is no doc yet. Throws a
 *  clear Error on a bad token (401) or a network/other failure so the caller can
 *  surface it as a sync error without ever corrupting the local doc. */
export async function pullDoc(
  token: string,
): Promise<{ text: string; updatedAt: string } | null> {
  let res: Response;
  // Bound the request so a hung server can't block first paint when sync is on.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    res = await fetch('/api/doc', {
      method: 'GET',
      headers: authHeaders(token),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(
      `Sync: could not reach the server (${err instanceof Error ? err.message : String(err)}).`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    throw new Error('Sync: the token was rejected (401). Check it and try again.');
  }
  if (!res.ok) {
    throw new Error(`Sync: the server returned ${res.status}.`);
  }
  let body: { text?: unknown; updatedAt?: unknown };
  try {
    body = await res.json();
  } catch {
    throw new Error('Sync: the server sent a malformed response.');
  }
  const text = typeof body.text === 'string' ? body.text : '';
  const updatedAt = typeof body.updatedAt === 'string' ? body.updatedAt : '';
  // A doc EXISTS iff the server has an updatedAt for it. An empty text WITH an
  // updatedAt is an intentionally-cleared list — return it so the store adopts
  // the empty state (deleting everything propagates). Only a never-written doc
  // (no updatedAt) reports null, which the store treats as "seed me".
  if (updatedAt === '') return null;
  return { text, updatedAt };
}

/** The outcome of a push. `conflict` distinguishes a 409 (the server moved on
 *  since our base — the current server doc is returned so we can reconcile,
 *  WITHOUT treating it as an error) from a clean write. */
export interface PushResult {
  conflict: boolean;
  /** The server's updatedAt: the new stamp on success, or the current one on a
   *  conflict. */
  updatedAt: string;
  /** Present on a conflict: the current server text. */
  text?: string;
}

export interface PushOptions {
  /** The updatedAt we last saw; sent as a precondition for a conditional PUT.
   *  Null/omitted -> no stamp precondition (see `expectEmpty`; without either an
   *  unconditional last-write-wins overwrite). */
  ifMatch?: string | null;
  /** Send an EXPECT-EMPTY precondition ({@link EXPECT_EMPTY_PRECONDITION}): the
   *  write must only land when the server has NO doc yet — a never-synced device
   *  seeding a shared server. The server 409s if any doc already exists. Ignored
   *  when a truthy `ifMatch` is given (a real stamp wins). This is what stops a
   *  brand-new device from unconditionally clobbering an existing shared list. */
  expectEmpty?: boolean;
  /** Fire the request with keepalive so it survives a page unload (flush path). */
  keepalive?: boolean;
  /** Abort the request after this many ms (default 8s), matching pullDoc so a
   *  hung PUT can't wedge the sync status forever. */
  timeoutMs?: number;
}

/** Push the current text to the server. Returns a {@link PushResult}: a clean
 *  write, or a conflict (409) carrying the current server doc. Throws a clear
 *  Error only on a bad token (401), a timeout, or any other non-2xx/network
 *  failure — never on a conflict. */
export async function pushDoc(
  token: string,
  text: string,
  opts: PushOptions = {},
): Promise<PushResult> {
  const { ifMatch, expectEmpty, keepalive, timeoutMs = 8000 } = opts;
  const headers: Record<string, string> = {
    ...authHeaders(token),
    'Content-Type': 'application/json',
  };
  // A real stamp wins; else an expect-empty seed carries the sentinel; else no
  // precondition at all (unconditional last-write-wins — old clients / explicit
  // force only). Never an empty header value (fragile) — the sentinel is a real
  // non-empty token the server can tell apart from "no precondition".
  const precondition = ifMatch ? ifMatch : expectEmpty ? EXPECT_EMPTY_PRECONDITION : null;
  const payload: { text: string; baseUpdatedAt?: string } = { text };
  if (precondition) {
    headers['If-Match'] = precondition;
    // Also carry the precondition in the body: a keepalive flush is the one place
    // a header can be dropped, and the server accepts either.
    payload.baseUpdatedAt = precondition;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch('/api/doc', {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      keepalive,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Sync: the request timed out.');
    }
    throw new Error(
      `Sync: could not reach the server (${err instanceof Error ? err.message : String(err)}).`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    throw new Error('Sync: the token was rejected (401). Check it and try again.');
  }
  if (res.status === 409) {
    let body: { updatedAt?: unknown; text?: unknown } = {};
    try {
      body = await res.json();
    } catch {
      // A malformed 409 body still means "don't overwrite" — reconcile blind.
    }
    return {
      conflict: true,
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : '',
      text: typeof body.text === 'string' ? body.text : '',
    };
  }
  if (!res.ok) {
    throw new Error(`Sync: the server returned ${res.status}.`);
  }
  let updatedAt = '';
  try {
    const body = (await res.json()) as { updatedAt?: unknown };
    if (typeof body.updatedAt === 'string') updatedAt = body.updatedAt;
  } catch {
    // A 200 with an unreadable body is still a successful write.
  }
  return { conflict: false, updatedAt };
}

export type { FsFileHandle, FsDirHandle };
