// Notes store — a SEPARATE zustand store from the to-do store (notes are their
// own subsystem: no undo/redo funnel, independent per-note autosave). Manifest +
// the currently-open note's draft, with debounced conditional-save (If-Match via
// baseUpdatedAt, mirroring web/lib/persist.ts pushDoc).

import { create } from 'zustand';
import type { NoteMeta, NoteFile } from '../lib/notes-api';
import {
  apiList, apiGet, apiCreate, apiSave, apiDelete, apiRestore, apiMove, apiPin,
} from '../lib/notes-api';

export type NotesStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'conflict' | 'error';

interface NotesState {
  notes: NoteMeta[];
  loaded: boolean;
  currentId: string | null;
  draft: string;
  base: string; // baseUpdatedAt of the open note
  status: NotesStatus;
  activeTag: string | null;
  graphOpen: boolean;

  loadManifest(): Promise<void>;
  open(id: string): Promise<void>;
  createNote(folder: string, title?: string): Promise<string | null>;
  setDraft(md: string): void;
  flush(): Promise<void>;
  removeNote(id: string): Promise<NoteFile | null>;
  restore(note: NoteFile): Promise<void>;
  moveTo(id: string, folder: string): Promise<void>;
  setPin(id: string, pinned: boolean): Promise<void>;
  folders(): string[];
  setActiveTag(tag: string | null): void;
  openByTitle(title: string): Promise<void>;
  setGraphOpen(open: boolean): void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false; // one save at a time; overlapping flushes coalesce
const AUTOSAVE_MS = 700;

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  loaded: false,
  currentId: null,
  draft: '',
  base: '',
  status: 'idle',
  activeTag: null,
  graphOpen: false,

  async loadManifest() {
    if (!get().loaded) set({ status: 'loading' });
    try {
      set({ notes: await apiList(), loaded: true });
      if (get().status === 'loading') set({ status: 'idle' });
    } catch {
      set({ status: 'error' });
    }
  },

  async open(id) {
    if (saveTimer) await get().flush();
    try {
      const n = await apiGet(id);
      set({ currentId: n.id, draft: n.markdown, base: n.updatedAt, status: 'idle', graphOpen: false });
    } catch {
      set({ status: 'error' });
    }
  },

  async createNote(folder, title = '') {
    if (saveTimer) await get().flush();
    try {
      const n = await apiCreate(folder, title);
      set({ currentId: n.id, draft: n.markdown, base: n.updatedAt, status: 'idle', graphOpen: false });
      await get().loadManifest();
      return n.id;
    } catch {
      set({ status: 'error' });
      return null;
    }
  },

  setDraft(md) {
    set({ draft: md, status: 'saving' });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void get().flush(); }, AUTOSAVE_MS);
  },

  async flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const currentId = get().currentId;
    if (!currentId || inFlight) return; // a save is already running — see the coalesce below
    inFlight = true;
    const savedDraft = get().draft;
    const savedBase = get().base;
    try {
      const r = await apiSave(currentId, savedDraft, savedBase);
      if ('conflict' in r) {
        // Another device moved this note on. Keep the local text but adopt the
        // server stamp so the next save wins (last-write-wins after a visible
        // 'conflict' blip) — no silent data loss of what the user just typed.
        set({ base: r.updatedAt, status: 'conflict' });
      } else {
        set({ base: r.updatedAt, status: 'saved' });
        await get().loadManifest(); // refresh title/snippet/updatedAt in the list
      }
    } catch {
      set({ status: 'error' });
    } finally {
      inFlight = false;
      // Coalesce: if the text changed while that save was in flight, persist the
      // newest draft (a short debounce) instead of firing overlapping PUTs.
      if (get().currentId === currentId && get().draft !== savedDraft) {
        set({ status: 'saving' });
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { void get().flush(); }, 300);
      }
    }
  },

  async removeNote(id) {
    try {
      const note = await apiDelete(id);
      if (get().currentId === id) set({ currentId: null, draft: '', base: '' });
      await get().loadManifest();
      return note;
    } catch {
      set({ status: 'error' });
      return null;
    }
  },

  async restore(note) {
    try { await apiRestore(note); await get().loadManifest(); } catch { /* best effort */ }
  },
  async moveTo(id, folder) {
    try { await apiMove(id, folder); await get().loadManifest(); } catch { /* best effort */ }
  },
  async setPin(id, pinned) {
    try { await apiPin(id, pinned); await get().loadManifest(); } catch { /* best effort */ }
  },

  folders() {
    const s = new Set<string>();
    for (const n of get().notes) if (n.folder) s.add(n.folder);
    return [...s].sort();
  },

  setActiveTag(tag) {
    set({ activeTag: tag });
  },

  setGraphOpen(open) {
    set({ graphOpen: open });
  },

  async openByTitle(title) {
    const t = title.trim();
    const hit = get().notes.find((n) => n.title.toLowerCase() === t.toLowerCase());
    if (hit) { await get().open(hit.id); return; }
    await get().createNote('', t); // auto-create a missing wiki-link target
  },
}));
