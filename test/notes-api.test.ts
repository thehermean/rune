import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../server/index';

// Handler-level tests for the /api/notes collection against a real temp data
// dir, mirroring test/doc-api.test.ts (in-process app.fetch, RUNE_DATA_DIR per
// test). Exercises create/get/save(+conflict)/list-derivation/move/delete/
// restore, auth, and path-traversal rejection.

const TOKEN = 'test-token';
const dirs: string[] = [];

beforeEach(() => {
  const d = mkdtempSync(join(tmpdir(), 'rune-notes-'));
  dirs.push(d);
  process.env.RUNE_DATA_DIR = d;
  process.env.RUNE_TOKEN = TOKEN;
  delete process.env.RUNE_OPEN_SYNC;
});
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function req(method: string, path: string, body?: unknown, auth = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth !== 'none') headers.authorization = `Bearer ${auth}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.fetch(new Request(`http://test${path}`, init));
}
const jsonOf = async (r: Response): Promise<any> => r.json();

describe('/api/notes', () => {
  it('creates, saves, and lists with derived title/snippet/tags/folder', async () => {
    const created = await jsonOf(await req('POST', '/api/notes', { folder: 'Work', title: 'Q3' }));
    const save = await req('PUT', `/api/notes/${created.id}`, {
      markdown: '# Q3\n\n- [ ] ship #work', baseUpdatedAt: created.updatedAt,
    });
    expect(save.status).toBe(200);
    const list = await jsonOf(await req('GET', '/api/notes'));
    expect(list.notes).toHaveLength(1);
    expect(list.notes[0].title).toBe('Q3');
    expect(list.notes[0].folder).toBe('Work');
    expect(list.notes[0].tags).toContain('work');
  });

  it('409s a stale conditional save (no clobber)', async () => {
    const note = await jsonOf(await req('POST', '/api/notes', {}));
    const r = await req('PUT', `/api/notes/${note.id}`, { markdown: 'x', baseUpdatedAt: '1999-01-01T00:00:00.000Z' });
    expect(r.status).toBe(409);
  });

  it('rejects a folder that escapes the notes root', async () => {
    expect((await req('POST', '/api/notes', { folder: '../evil' })).status).toBe(400);
  });

  it('401s without a token when not in open mode', async () => {
    expect((await req('GET', '/api/notes', undefined, 'none')).status).toBe(401);
  });

  it('delete returns a restore ticket; restore brings it back', async () => {
    const note = await jsonOf(await req('POST', '/api/notes', { title: 'X' }));
    const del = await jsonOf(await req('DELETE', `/api/notes/${note.id}`));
    expect(del.ok).toBe(true);
    expect((await jsonOf(await req('GET', '/api/notes'))).notes).toHaveLength(0);
    await req('POST', `/api/notes/${note.id}/restore`, { note: del.note });
    expect((await jsonOf(await req('GET', '/api/notes'))).notes).toHaveLength(1);
  });

  it('moves a note between folders', async () => {
    const note = await jsonOf(await req('POST', '/api/notes', { folder: 'A', title: 'm' }));
    expect((await req('POST', `/api/notes/${note.id}/move`, { folder: 'B' })).status).toBe(200);
    const list = await jsonOf(await req('GET', '/api/notes'));
    expect(list.notes[0].folder).toBe('B');
  });

  it('full-text search matches note bodies', async () => {
    const a = await jsonOf(await req('POST', '/api/notes', { title: 'Alpha' }));
    await req('PUT', `/api/notes/${a.id}`, { markdown: '# Alpha\n\nthe quick brown fox', baseUpdatedAt: a.updatedAt });
    const b = await jsonOf(await req('POST', '/api/notes', { title: 'Beta' }));
    await req('PUT', `/api/notes/${b.id}`, { markdown: '# Beta\n\nlazy dog', baseUpdatedAt: b.updatedAt });
    const res = await jsonOf(await req('GET', '/api/notes/search?q=brown'));
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0].title).toBe('Alpha');
  });

  it('uploads an attachment and serves it back with its content-type', async () => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', { type: 'image/png' }));
    const up = await app.fetch(new Request('http://test/api/notes-attachments', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: fd,
    }));
    expect(up.status).toBe(200);
    const { url } = (await up.json()) as { url: string };
    expect(url).toMatch(/^\/api\/notes-attachments\/[a-f0-9]+\.png$/);
    const got = await app.fetch(new Request(`http://test${url}`));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
  });
});
