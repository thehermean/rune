import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../server/index';

// Trusted-network ("open") sync mode: RUNE_OPEN_SYNC=1 lets /api/doc GET/PUT run
// WITHOUT a bearer token, while a presented non-empty token must still be valid,
// the default (unset) mode is byte-for-byte unchanged, and share publish stays
// RUNE_TOKEN-gated regardless. Same in-process app.fetch style as doc-api.test.

const TOKEN = 'test-token';
const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'rune-open-'));
  dirs.push(dir);
  process.env.RUNE_DATA_DIR = dir;
  delete process.env.RUNE_OPEN_SYNC; // each test opts in explicitly
});

afterEach(() => {
  // Never leak open-mode into other test files sharing this worker's process.env.
  delete process.env.RUNE_OPEN_SYNC;
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

/** Fetch /api/doc. `auth: 'none'` omits the header; otherwise sends a bearer. */
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

describe('open sync — RUNE_OPEN_SYNC=1, RUNE_TOKEN set', () => {
  beforeEach(() => {
    process.env.RUNE_OPEN_SYNC = '1';
    process.env.RUNE_TOKEN = TOKEN;
  });

  it('GET with NO token returns the doc (the discovery probe succeeds)', async () => {
    const res = await doc('GET', { auth: 'none' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '', updatedAt: '' });
  });

  it('PUT with NO token writes, and GET reflects it', async () => {
    const put = await doc('PUT', { body: { text: 'from a tokenless device' }, auth: 'none' });
    expect(put.status).toBe(200);
    const g = (await (await doc('GET', { auth: 'none' })).json()) as { text: string };
    expect(g.text).toBe('from a tokenless device');
  });

  it('a valid token still works', async () => {
    expect((await doc('GET', { auth: TOKEN })).status).toBe(200);
    expect((await doc('PUT', { body: { text: 'ok' }, auth: TOKEN })).status).toBe(200);
  });

  it('a PRESENTED wrong non-empty token still 401s (misconfig fails loudly)', async () => {
    expect((await doc('GET', { auth: 'wrong' })).status).toBe(401);
    expect((await doc('PUT', { body: { text: 'x' }, auth: 'wrong' })).status).toBe(401);
  });

  it('the conditional-PUT 409 conflict path is preserved with no token', async () => {
    await doc('PUT', { body: { text: 'server-wins' }, auth: 'none' });
    const res = await doc('PUT', {
      body: { text: 'stale' },
      auth: 'none',
      ifMatch: 'OLD-STAMP',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; text: string };
    expect(body.error).toBe('conflict');
    expect(body.text).toBe('server-wins');
  });
});

describe('open sync — RUNE_OPEN_SYNC=1, RUNE_TOKEN unset', () => {
  beforeEach(() => {
    process.env.RUNE_OPEN_SYNC = '1';
    delete process.env.RUNE_TOKEN;
  });

  it('still serves GET/PUT with no token (zero-config tailnet instance)', async () => {
    expect((await doc('GET', { auth: 'none' })).status).toBe(200);
    expect((await doc('PUT', { body: { text: 'hi' }, auth: 'none' })).status).toBe(200);
    expect(((await (await doc('GET', { auth: 'none' })).json()) as { text: string }).text).toBe(
      'hi',
    );
  });

  it('a presented non-empty token 401s (nothing to validate it against)', async () => {
    expect((await doc('GET', { auth: 'whatever' })).status).toBe(401);
  });
});

describe('open sync does NOT open other capabilities', () => {
  beforeEach(() => {
    process.env.RUNE_OPEN_SYNC = '1';
    process.env.RUNE_TOKEN = TOKEN;
  });

  it('share publish stays RUNE_TOKEN-gated (401 without a token even in open mode)', async () => {
    const res = await app.fetch(
      new Request('http://test/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '- [ ] hi' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('publish with the valid token still works in open mode', async () => {
    const res = await app.fetch(
      new Request('http://test/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: '- [ ] hi' }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('default mode unchanged (RUNE_OPEN_SYNC unset)', () => {
  beforeEach(() => {
    process.env.RUNE_TOKEN = TOKEN;
  });

  it('GET with no token 401s (probe reports token required)', async () => {
    expect((await doc('GET', { auth: 'none' })).status).toBe(401);
  });

  it('GET/PUT with the valid token work', async () => {
    expect((await doc('PUT', { body: { text: 'v' } })).status).toBe(200);
    expect((await doc('GET')).status).toBe(200);
  });
});
