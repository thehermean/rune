import { describe, it, expect, afterEach } from 'vitest';
import { writeAttachment, readAttachment, pushDoc } from '../web/lib/persist';

// Minimal in-memory File System Access handles, enough to exercise the byte-copy
// + read-back logic without a real browser/native picker. Typed `any` so the
// structural mock can stand in for the FsDirHandle/File parameters.

function memFile(name: string, data = ''): any {
  const self: any = {
    kind: 'file',
    name,
    _data: data,
    async getFile() {
      return { name, text: async () => self._data };
    },
    async createWritable() {
      return {
        async write(d: any) {
          self._data = typeof d === 'string' ? d : await d.text();
        },
        async close() {},
      };
    },
  };
  return self;
}

function memDir(name = 'root'): any {
  const files = new Map<string, any>();
  const dirs = new Map<string, any>();
  return {
    kind: 'directory',
    name,
    files,
    dirs,
    async getFileHandle(n: string, opts?: { create?: boolean }) {
      let f = files.get(n);
      if (!f) {
        if (!opts?.create) throw new Error('NotFound');
        f = memFile(n);
        files.set(n, f);
      }
      return f;
    },
    async getDirectoryHandle(n: string, opts?: { create?: boolean }) {
      let d = dirs.get(n);
      if (!d) {
        if (!opts?.create) throw new Error('NotFound');
        d = memDir(n);
        dirs.set(n, d);
      }
      return d;
    },
    async *values() {
      for (const f of files.values()) yield f;
      for (const d of dirs.values()) yield d;
    },
  };
}

const fakeFile = (name: string, data: string): any => ({ name, text: async () => data });

describe('directory-backed attachments', () => {
  it('copies bytes into attachments/ and returns the relative ref', async () => {
    const dir = memDir();
    const rel = await writeAttachment(dir, fakeFile('Report (v2).pdf', 'BYTES'));
    expect(rel).toBe('attachments/Report (v2).pdf');
    expect(dir.dirs.get('attachments').files.get('Report (v2).pdf')._data).toBe('BYTES');
  });

  it('de-dupes a name collision instead of clobbering', async () => {
    const dir = memDir();
    const a = await writeAttachment(dir, fakeFile('a.pdf', 'first'));
    const b = await writeAttachment(dir, fakeFile('a.pdf', 'second'));
    expect(a).toBe('attachments/a.pdf');
    expect(b).toBe('attachments/a-1.pdf');
    const att = dir.dirs.get('attachments');
    expect(att.files.get('a.pdf')._data).toBe('first');
    expect(att.files.get('a-1.pdf')._data).toBe('second');
  });

  it('reads a stored attachment back via its %-encoded path', async () => {
    const dir = memDir();
    await writeAttachment(dir, fakeFile('Report (v2).pdf', 'BYTES'));
    // The store persists the target %-encoded; readAttachment must decode it.
    const file = await readAttachment(dir, 'attachments/Report%20%28v2%29.pdf');
    expect(file).not.toBeNull();
    expect(await file!.text()).toBe('BYTES');
  });

  it('returns null for a missing attachment', async () => {
    expect(await readAttachment(memDir(), 'attachments/nope.pdf')).toBeNull();
  });
});

describe('pushDoc', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('aborts and throws a timeout error when the server hangs', async () => {
    // A fetch that never resolves on its own — it only rejects when the
    // AbortController fires, exactly as a real hung request would.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as typeof fetch;

    await expect(pushDoc('tok', 'hello', { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
  });

  it('returns a conflict (not a throw) on a 409, carrying the current server doc', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'conflict', updatedAt: 'X', text: 'server' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const res = await pushDoc('tok', 'local', { ifMatch: 'old' });
    expect(res.conflict).toBe(true);
    expect(res.updatedAt).toBe('X');
    expect(res.text).toBe('server');
  });

  it('returns the new updatedAt on a clean write', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, updatedAt: 'Y' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const res = await pushDoc('tok', 'local');
    expect(res.conflict).toBe(false);
    expect(res.updatedAt).toBe('Y');
  });

  it('throws on a rejected token (401)', async () => {
    globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
    await expect(pushDoc('tok', 'local')).rejects.toThrow(/401/);
  });

  it('a never-synced seed sends an expect-empty precondition, and a 409 is a conflict (not a throw)', async () => {
    // The incident fix: a device that has never synced must not PUT unconditionally.
    // It sends the expect-empty sentinel (header + body); an existing server doc
    // 409s instead of being clobbered.
    let seenHeaders: Record<string, string> = {};
    let seenBody: { baseUpdatedAt?: string } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      seenBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ error: 'conflict', updatedAt: 'X', text: 'REAL LIST' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const res = await pushDoc('tok', 'onboarding seed', { expectEmpty: true });
    expect(seenHeaders['If-Match']).toBe('expect-empty');
    expect(seenBody.baseUpdatedAt).toBe('expect-empty'); // survives a keepalive flush
    expect(res.conflict).toBe(true);
    expect(res.text).toBe('REAL LIST'); // the real list, never overwritten
  });
});
