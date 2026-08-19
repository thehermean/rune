import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../server/index';
import { createSnapshot, getSnapshot, hasSnapshot } from '../server/store';
import { comments } from '../src/criticmarkup';
import { parse } from '../src/index';

// The self-hosted server persists under $RUNE_DATA_DIR; point it at a temp dir
// and gate publish/comment/delete with a test RUNE_TOKEN (read lazily per call).
const TOKEN = 'test-token';
let DATA_DIR: string;

beforeAll(() => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'rune-server-'));
  process.env.RUNE_DATA_DIR = DATA_DIR;
  process.env.RUNE_TOKEN = TOKEN;
});
afterAll(() => {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const HEADER = '<!-- rune v1 · ids:^t-xxxx · comments:criticmarkup -->';
const DOC = [
  HEADER,
  '# Sprint @sam',
  '',
  '- [/] Ship parser !!! due:2026-07-10 ^t-1',
  '  > a child note',
  '  - [x] Survey formats ^t-2',
  '- [ ] Pay <invoice> @finance ^t-4',
].join('\n');

async function get(path: string): Promise<Response> {
  return app.fetch(new Request('http://test' + path));
}
async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request('http://test' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}
const auth = { authorization: `Bearer ${TOKEN}` };

/** Publish via the API and return { id, writeToken }. */
async function publish(text: string): Promise<{ id: string; writeToken: string }> {
  const res = await post('/api/publish', { text }, auth);
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; writeToken: string };
}

describe('snapshot store', () => {
  it('mints an unguessable (>=22 char) id + a write token and round-trips', () => {
    const { snapshot, writeToken } = createSnapshot(DOC);
    expect(snapshot.id.length).toBeGreaterThanOrEqual(22);
    expect(writeToken.length).toBeGreaterThanOrEqual(16);
    expect(snapshot.writeTokenHash).toBeTruthy();
    expect(getSnapshot(snapshot.id)?.text).toBe(DOC);
    expect(hasSnapshot(snapshot.id)).toBe(true);
    expect(hasSnapshot('no-such-id-000000')).toBe(false);
  });

  it('mints distinct ids per call', () => {
    const a = createSnapshot('a');
    const b = createSnapshot('b');
    expect(a.snapshot.id).not.toBe(b.snapshot.id);
  });
});

describe('POST /api/publish', () => {
  it('returns id + writeToken + share + raw links', async () => {
    const res = await post('/api/publish', { text: DOC }, auth);
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      id: string;
      writeToken: string;
      url: string;
      rawUrl: string;
    };
    expect(j.id.length).toBeGreaterThanOrEqual(22);
    expect(j.writeToken.length).toBeGreaterThanOrEqual(16);
    expect(j.url).toBe(`/d/${j.id}`);
    expect(j.rawUrl).toBe(`/d/${j.id}.txt`);
  });

  it('401s a publish with no/bad instance token', async () => {
    expect((await post('/api/publish', { text: DOC })).status).toBe(401);
    expect(
      (await post('/api/publish', { text: DOC }, { authorization: 'Bearer nope' })).status,
    ).toBe(401);
  });

  it('rejects a non-string body', async () => {
    expect((await post('/api/publish', { text: 123 }, auth)).status).toBe(400);
  });

  it('413s a doc over the 5MB cap', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    expect((await post('/api/publish', { text: big }, auth)).status).toBe(413);
  });
});

describe('GET /d/:id.txt — exact canonical bytes', () => {
  it('returns text/plain inline, byte-identical, with hardened headers', async () => {
    const { id } = await publish(DOC);
    const res = await get(`/d/${id}.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(await res.text()).toBe(DOC);
  });

  it('?raw=1 still returns the full canonical bytes', async () => {
    const { id } = await publish(DOC);
    expect(await (await get(`/d/${id}.txt?raw=1`)).text()).toBe(DOC);
  });

  it('?items= scopes to the named task lines and keeps the leading header comment', async () => {
    const { id } = await publish(DOC);
    const body = await (await get(`/d/${id}.txt?items=t-1`)).text();
    expect(body).toContain('- [/] Ship parser !!! due:2026-07-10 ^t-1');
    expect(body).toContain('> a child note');
    // The self-briefing header line survives scoping.
    expect(body.startsWith(HEADER)).toBe(true);
    expect(body).not.toContain('Pay');
    expect(body).not.toContain('Survey formats');
  });

  it('404s a missing id', async () => {
    expect((await get('/d/missing-000000000000.txt')).status).toBe(404);
  });
});

describe('GET /d/:id — HTML render', () => {
  it('renders and escapes all user text', async () => {
    const { id } = await publish(DOC);
    const html = await (await get(`/d/${id}`)).text();
    expect(html).toContain('&lt;invoice&gt;');
    expect(html).not.toContain('Pay <invoice>');
  });

  it('404s a missing id', async () => {
    expect((await get('/d/missing-000000000000')).status).toBe(404);
  });

  it('renders headings as siblings outside any <ul> with no empty lists', async () => {
    const doc = ['# Top', '- [ ] one ^a', '## Middle', '- [ ] two ^b', '# Bottom'].join('\n');
    const { id } = await publish(doc);
    const html = await (await get(`/d/${id}`)).text();
    expect(html).not.toMatch(/<ul>\s*<\/ul>/);
    expect(html).not.toMatch(/<ul>\s*<h[1-6]/);
    expect(html).toContain('<h1>Top</h1>');
    expect(html).toContain('<h2>Middle</h2>');
    expect(html).toContain('<h1>Bottom</h1>');
  });
});

describe('POST /api/d/:id/comments — write-token gated', () => {
  it('401s a comment write with no write token (read url is read-only)', async () => {
    const { id } = await publish(DOC);
    const res = await post(`/api/d/${id}/comments`, [{ itemId: 't-1', body: 'x' }]);
    expect(res.status).toBe(401);
    // The stored doc is untouched.
    expect(getSnapshot(id)?.text).toBe(DOC);
  });

  it('401s a wrong write token', async () => {
    const { id } = await publish(DOC);
    const res = await post(`/api/d/${id}/comments`, [{ itemId: 't-1', body: 'x' }], {
      authorization: 'Bearer wrong-write-token',
    });
    expect(res.status).toBe(401);
  });

  it('appends a CriticMarkup comment anchored by ^id with the write token', async () => {
    const { id, writeToken } = await publish(DOC);
    const res = await post(`/api/d/${id}/comments`, [
      { itemId: 't-1', body: 'looks good', author: 'ai', kind: 'comment' },
    ], { authorization: `Bearer ${writeToken}` });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; addedComments: number };
    expect(j.ok).toBe(true);
    expect(j.addedComments).toBe(1);
    const after = await (await get(`/d/${id}.txt`)).text();
    expect(after).toContain('{>> @ai: looks good <<}');
    expect(after).toContain('- [ ] Pay <invoice> @finance ^t-4');
  });

  it('accepts the write token via X-Rune-Write too', async () => {
    const { id, writeToken } = await publish(DOC);
    const res = await post(`/api/d/${id}/comments`, [{ itemId: 't-1', body: 'hi' }], {
      'x-rune-write': writeToken,
    });
    expect(res.status).toBe(200);
    const after = await (await get(`/d/${id}.txt`)).text();
    expect(after).toContain('{>> hi <<}');
    expect(after).not.toContain('{>> : hi <<}');
    const line = after.split('\n').find((l) => l.includes('^t-1'))!;
    const parsed = comments(parse(line)).find((c) => c.kind === 'comment');
    expect(parsed?.author).toBe('');
    expect(parsed?.body).toBe('hi');
  });

  it('neutralises brace chars in the comment body', async () => {
    const { id, writeToken } = await publish(DOC);
    await post(`/api/d/${id}/comments`, [{ itemId: 't-1', body: 'a } b { c' }], {
      authorization: `Bearer ${writeToken}`,
    });
    const after = await (await get(`/d/${id}.txt`)).text();
    const line = after.split('\n').find((l) => l.includes('^t-1'))!;
    expect(line.match(/\{>>/g)?.length).toBe(1);
    expect(line.match(/<<\}/g)?.length).toBe(1);
  });

  it('422s when an itemId has no matching task', async () => {
    const { id, writeToken } = await publish(DOC);
    const res = await post(`/api/d/${id}/comments`, [{ itemId: 'nope', body: 'x' }], {
      authorization: `Bearer ${writeToken}`,
    });
    expect(res.status).toBe(422);
  });

  it('404s a missing snapshot', async () => {
    const res = await post('/api/d/missing-000000000000/comments', [{ itemId: 't-1', body: 'x' }]);
    expect(res.status).toBe(404);
  });

  it('413s a comments call over the 64KB cap', async () => {
    const { id, writeToken } = await publish(DOC);
    const big = 'y'.repeat(64 * 1024 + 1);
    const res = await post(`/api/d/${id}/comments`, [{ itemId: 't-1', body: big }], {
      authorization: `Bearer ${writeToken}`,
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /api/d/:id/comments — annotatedText merge', () => {
  it('accepts a clean standalone-comment paste and merges it', async () => {
    const { id, writeToken } = await publish(DOC);
    const annotated = DOC + '\n{>> @ai: nice work <<}';
    const res = await post(`/api/d/${id}/comments`, { annotatedText: annotated }, {
      authorization: `Bearer ${writeToken}`,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; addedComments: number };
    expect(j.ok).toBe(true);
    expect(j.addedComments).toBeGreaterThanOrEqual(1);
    expect(await (await get(`/d/${id}.txt`)).text()).toBe(annotated);
  });

  it('rejects (422) a paste that mutates a non-annotation byte', async () => {
    const { id, writeToken } = await publish(DOC);
    const bad = DOC.replace('Ship parser', 'Ship the parser');
    const res = await post(`/api/d/${id}/comments`, { annotatedText: bad }, {
      authorization: `Bearer ${writeToken}`,
    });
    expect(res.status).toBe(422);
    const j = (await res.json()) as { ok: boolean; rejectedReason: string };
    expect(j.ok).toBe(false);
    expect(j.rejectedReason).toBeTruthy();
    expect(getSnapshot(id)?.text).toBe(DOC);
  });
});

describe('DELETE /api/d/:id — unpublish', () => {
  it('401s without the write token and leaves the snapshot', async () => {
    const { id } = await publish(DOC);
    const res = await app.fetch(new Request(`http://test/api/d/${id}`, { method: 'DELETE' }));
    expect(res.status).toBe(401);
    expect(hasSnapshot(id)).toBe(true);
  });

  it('removes the snapshot with the write token', async () => {
    const { id, writeToken } = await publish(DOC);
    const res = await app.fetch(
      new Request(`http://test/api/d/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${writeToken}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(hasSnapshot(id)).toBe(false);
    expect((await get(`/d/${id}.txt`)).status).toBe(404);
  });

  it('404s deleting a missing snapshot', async () => {
    const res = await app.fetch(
      new Request('http://test/api/d/missing-000000000000', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });
});
