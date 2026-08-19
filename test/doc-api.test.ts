import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../server/index';

// Handler-level tests for the ported /api/doc sync route against a real temp
// data dir (no Redis). The route reads RUNE_TOKEN / RUNE_DATA_DIR lazily on each
// request, so we can point them at a fresh dir per test for isolation and
// exercise the full wire contract (200 / 400 / 401 / 409 / 413 / 503) in-process
// via app.fetch — the same style as test/server.test.ts.

const TOKEN = 'test-token';
const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'rune-doc-'));
  dirs.push(dir);
  process.env.RUNE_DATA_DIR = dir;
  process.env.RUNE_TOKEN = TOKEN;
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function doc(
  method: string,
  opts: { body?: unknown; auth?: string; ifMatch?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.auth !== 'none') headers.authorization = `Bearer ${opts.auth ?? TOKEN}`;
  if (opts.ifMatch !== undefined) headers['if-match'] = opts.ifMatch;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  return app.fetch(new Request('http://test/api/doc', init));
}

describe('GET /api/doc', () => {
  it('returns empty text + empty updatedAt when no doc exists', async () => {
    const res = await doc('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '', updatedAt: '' });
  });

  it('returns the stored doc', async () => {
    await doc('PUT', { body: { text: 'hi' } });
    const res = await doc('GET');
    const body = (await res.json()) as { text: string; updatedAt: string };
    expect(body.text).toBe('hi');
    expect(body.updatedAt).not.toBe('');
  });

  it('401s a wrong token', async () => {
    expect((await doc('GET', { auth: 'nope' })).status).toBe(401);
  });

  it('401s a missing token', async () => {
    expect((await doc('GET', { auth: 'none' })).status).toBe(401);
  });
});

describe('PUT /api/doc — atomic write', () => {
  it('writes text and updatedAt together, and GET reflects the same pair', async () => {
    const put = await doc('PUT', { body: { text: 'canonical bytes' } });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { ok: boolean; updatedAt: string };
    expect(putBody.ok).toBe(true);
    expect(putBody.updatedAt).not.toBe('');

    const g = (await (await doc('GET')).json()) as { text: string; updatedAt: string };
    expect(g.text).toBe('canonical bytes');
    expect(g.updatedAt).toBe(putBody.updatedAt);
  });

  it('400s a non-string body', async () => {
    expect((await doc('PUT', { body: { text: 123 } })).status).toBe(400);
  });

  it('400s a malformed JSON body', async () => {
    const res = await app.fetch(
      new Request('http://test/api/doc', {
        method: 'PUT',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{ not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('413s a document over the 5MB cap', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    expect((await doc('PUT', { body: { text: big } })).status).toBe(413);
  });
});

describe('PUT /api/doc — conditional (If-Match)', () => {
  it('accepts a write whose precondition matches the current stamp', async () => {
    const first = (await (await doc('PUT', { body: { text: 'v1' } })).json()) as {
      updatedAt: string;
    };
    const res = await doc('PUT', { body: { text: 'v2' }, ifMatch: first.updatedAt });
    expect(res.status).toBe(200);
    expect(((await (await doc('GET')).json()) as { text: string }).text).toBe('v2');
  });

  it('409s a stale precondition WITHOUT overwriting, returning the current doc', async () => {
    await doc('PUT', { body: { text: 'server-wins' } });
    const cur = (await (await doc('GET')).json()) as { updatedAt: string };
    const res = await doc('PUT', { body: { text: 'stale-local' }, ifMatch: 'OLD-STAMP' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; updatedAt: string; text: string };
    expect(body.error).toBe('conflict');
    expect(body.updatedAt).toBe(cur.updatedAt);
    expect(body.text).toBe('server-wins');
    // The server doc is untouched by the rejected write.
    expect(((await (await doc('GET')).json()) as { text: string }).text).toBe('server-wins');
  });

  it('accepts a precondition passed via the body (keepalive flush path)', async () => {
    const first = (await (await doc('PUT', { body: { text: 'v1' } })).json()) as {
      updatedAt: string;
    };
    const res = await doc('PUT', { body: { text: 'v2', baseUpdatedAt: first.updatedAt } });
    expect(res.status).toBe(200);
    expect(((await (await doc('GET')).json()) as { text: string }).text).toBe('v2');
  });

  it('an unconditional PUT still overwrites (backward compat)', async () => {
    await doc('PUT', { body: { text: 'v1' } });
    const res = await doc('PUT', { body: { text: 'forced' } });
    expect(res.status).toBe(200);
    expect(((await (await doc('GET')).json()) as { text: string }).text).toBe('forced');
  });
});

describe('PUT /api/doc — expect-empty precondition (never-synced seed)', () => {
  it('writes when the server has no doc yet', async () => {
    const res = await doc('PUT', { body: { text: 'seed real content' }, ifMatch: 'expect-empty' });
    expect(res.status).toBe(200);
    expect(((await (await doc('GET')).json()) as { text: string }).text).toBe('seed real content');
  });

  it('409s WITHOUT overwriting when a doc already exists (the incident guard)', async () => {
    await doc('PUT', { body: { text: 'the real list' } });
    const res = await doc('PUT', {
      body: { text: 'onboarding seed' },
      ifMatch: 'expect-empty',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; text: string };
    expect(body.error).toBe('conflict');
    expect(body.text).toBe('the real list');
    // The real list is untouched by the rejected expect-empty write.
    expect(((await (await doc('GET')).json()) as { text: string }).text).toBe('the real list');
  });

  it('honours an expect-empty precondition carried in the body (keepalive flush path)', async () => {
    await doc('PUT', { body: { text: 'the real list' } });
    const res = await doc('PUT', { body: { text: 'onboarding seed', baseUpdatedAt: 'expect-empty' } });
    expect(res.status).toBe(409);
    expect(((await (await doc('GET')).json()) as { text: string }).text).toBe('the real list');
  });
});

describe('/api/doc — configuration + methods', () => {
  it('503s when RUNE_TOKEN is unset', async () => {
    const saved = process.env.RUNE_TOKEN;
    delete process.env.RUNE_TOKEN;
    try {
      const res = await doc('GET', { auth: 'none' });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('sync not configured');
    } finally {
      process.env.RUNE_TOKEN = saved;
    }
  });

  it('204s an OPTIONS preflight with an Allow header', async () => {
    const res = await app.fetch(new Request('http://test/api/doc', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('allow')).toContain('PUT');
  });

  it('405s an unsupported method', async () => {
    const res = await doc('PATCH', { body: { text: 'x' } });
    expect(res.status).toBe(405);
  });
});
