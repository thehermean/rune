// Thin fetch wrappers over the /api/notes collection (same-origin). On a trusted
// tailnet the server runs RUNE_OPEN_SYNC so no token is needed — mirrors the
// token-free path in web/lib/persist.ts.

export interface NoteMeta {
  id: string;
  folder: string;
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
  markdown: string;
  pinned: boolean;
  created: string;
  updatedAt: string;
}

const BASE = '/api/notes';
const jsonHeaders = { 'content-type': 'application/json' } as const;

export async function apiList(): Promise<NoteMeta[]> {
  const r = await fetch(BASE);
  if (!r.ok) throw new Error(`list ${r.status}`);
  const d = (await r.json()) as { notes: NoteMeta[] };
  return d.notes;
}

export async function apiSearch(q: string): Promise<NoteMeta[]> {
  const r = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`search ${r.status}`);
  return ((await r.json()) as { notes: NoteMeta[] }).notes;
}

export async function apiGet(id: string): Promise<NoteFile> {
  const r = await fetch(`${BASE}/${id}`);
  if (!r.ok) throw new Error(`get ${r.status}`);
  return (await r.json()) as NoteFile;
}

export async function apiCreate(folder: string, title = ''): Promise<NoteFile> {
  const r = await fetch(BASE, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ folder, title }) });
  if (!r.ok) throw new Error(`create ${r.status}`);
  return (await r.json()) as NoteFile;
}

export type SaveResp =
  | { ok: true; updatedAt: string }
  | { conflict: true; updatedAt: string; markdown: string };

export async function apiSave(id: string, markdown: string, base: string): Promise<SaveResp> {
  const r = await fetch(`${BASE}/${id}`, {
    method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ markdown, baseUpdatedAt: base }),
  });
  if (r.status === 409) {
    const d = (await r.json()) as { updatedAt: string; markdown: string };
    return { conflict: true, updatedAt: d.updatedAt, markdown: d.markdown };
  }
  if (!r.ok) throw new Error(`save ${r.status}`);
  const d = (await r.json()) as { updatedAt: string };
  return { ok: true, updatedAt: d.updatedAt };
}

export async function apiDelete(id: string): Promise<NoteFile> {
  const r = await fetch(`${BASE}/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`delete ${r.status}`);
  const d = (await r.json()) as { note: NoteFile };
  return d.note;
}

export async function apiRestore(note: NoteFile): Promise<void> {
  await fetch(`${BASE}/${note.id}/restore`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ note }) });
}

export async function apiMove(id: string, folder: string): Promise<void> {
  await fetch(`${BASE}/${id}/move`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ folder }) });
}

export async function apiPin(id: string, pinned: boolean): Promise<void> {
  await fetch(`${BASE}/${id}/pin`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ pinned }) });
}

export async function apiUpload(file: File): Promise<{ url: string; name: string }> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/notes-attachments', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`upload ${r.status}`);
  return (await r.json()) as { url: string; name: string };
}
