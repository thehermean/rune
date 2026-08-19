// Rune self-hosted server — one node process serving:
//   (a) the sync API at /api/doc (single shared doc, file-backed) — see doc.ts,
//   (b) the share/publish/raw/HTML endpoints under /api/publish, /api/d/*, /d/*,
//   (c) the static built web app from dist/web with an SPA fallback.
//
// HTTPS is terminated upstream by `tailscale serve` proxying to this localhost
// port, so plain HTTP bound to 127.0.0.1 is correct. See DEPLOY.md.
//
// The raw endpoint returns the EXACT canonical bytes the renderer consumes —
// `Content-Type: text/plain; charset=utf-8`, `Content-Disposition: inline`, no
// HTML, no truncation — so an LLM (or curl) sees byte-for-byte what the app
// serializes. The HTML view is a quiet read-only projection; every byte of user
// text is escaped. Comments anchor to ^ids, never line numbers.
//
// Capability model: the docId (read url) is read-only. Publishing mints a
// distinct writeToken (returned once) required to append comments or unpublish.
// Publishing itself is gated by RUNE_TOKEN (single-user instance) so a tailnet
// peer can't fill the disk; GET share views need no token — that's the point of
// a capability url.

import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse, serializeNode, type Node, type TaskNode } from '../src/index';
import { mergeAnnotated } from '../src/reconcile';
import {
  createSnapshot,
  deleteSnapshot,
  getSnapshot,
  putSnapshot,
  SnapshotCapError,
} from './store';
import { checkToken, checkWriteToken } from './auth';
import { docApp } from './doc';
import { notesApp, attachmentsApp } from './notes';

const app = new Hono();

const PUBLISH_MAX_BYTES = 5 * 1024 * 1024; // 5MB doc cap on publish.
const COMMENTS_MAX_BYTES = 64 * 1024; // 64KB per comments call.

// --- Auth helpers ----------------------------------------------------------

/** Gate a write on the instance secret. Returns a Response to short-circuit, or
 *  null when the caller is authorised. */
function requireInstanceAuth(c: Context): Response | null {
  const expected = process.env.RUNE_TOKEN;
  if (!expected || expected === '') return c.json({ error: 'sharing not configured' }, 503);
  if (!checkToken(c.req.header('authorization'), expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return null;
}

/** The write token presented for a per-snapshot write: an Authorization bearer
 *  or the X-Rune-Write header. */
function presentedWriteToken(c: Context): string | undefined {
  const h = c.req.header('authorization');
  if (h && h.startsWith('Bearer ')) return h.slice('Bearer '.length);
  return c.req.header('x-rune-write') ?? undefined;
}

// --- HTML escaping (mandatory: user text is never trusted) ---------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- ?items= scoping ------------------------------------------------------
//
// `?items=t-a,t-b` narrows the raw output to the named task lines plus any of
// their indented child note/comment lines (descendants with strictly greater
// indent, up to the next sibling-or-shallower line). Lines belonging to a task
// NOT in the set are dropped. This is a best-effort textual subset; the result
// is still canonical bytes joined by "\n". The doc's leading `<!-- rune v1 … -->`
// header comment is preserved so scoped output still self-briefs a cold LLM.

function indentOf(node: Node): number {
  if (node.type === 'task') return node.indent;
  if (typeof (node as { indent?: unknown }).indent === 'number') {
    return (node as { indent: number }).indent;
  }
  const m = /^(\s*)/.exec(node.raw);
  return m ? m[1].length : 0;
}

function scopeText(text: string, items: Set<string>): string {
  const { nodes } = parse(text);
  // The self-briefing header comment (BRIEF §6) is the doc's leading
  // `<!-- rune v1 … -->` line — keep it on scoped output so an LLM handed a
  // subset still knows the format/anchor/reply rules.
  const header = nodes.find((n) => n.type === 'html-comment');
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type !== 'task') continue;
    const task = node as TaskNode;
    if (!task.id || !items.has(task.id)) continue;

    out.push(serializeNode(task));
    // Pull in the task's descendants until the next task line. Two inclusion
    // rules, both stopping at the next `task` (which owns its own scope):
    //   - indented children (notes/comments deeper than the task), AND
    //   - standalone CriticMarkup `comment` lines at ANY indent — these anchor
    //     to the nearest PRECEDING task by position, not indentation (see
    //     src/criticmarkup.ts comments()), and LLMs emit them at column 0.
    // Anything else at the task's own indent or shallower ends the scope.
    for (let j = i + 1; j < nodes.length; j++) {
      const child = nodes[j];
      if (child.type === 'task') break; // a nested task is its own item
      if (child.type === 'blank') continue; // skip blank spacers, don't stop
      if (child.type === 'comment') {
        // A standalone comment anchors to this task regardless of indent.
        out.push(serializeNode(child));
        continue;
      }
      if (indentOf(child) <= task.indent) break;
      out.push(serializeNode(child));
    }
  }
  if (out.length > 0 && header) out.unshift(serializeNode(header));
  return out.join('\n');
}

// --- Share routes ----------------------------------------------------------

// Publish: mint a snapshot and return its READ links + the one-time write token.
// Gated by RUNE_TOKEN (single-user instance).
app.post('/api/publish', async (c) => {
  const denied = requireInstanceAuth(c);
  if (denied) return denied;

  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > PUBLISH_MAX_BYTES) {
    return c.json({ error: 'document too large' }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') {
    return c.json({ error: 'expected { text: string }' }, 400);
  }
  if (Buffer.byteLength(text, 'utf8') > PUBLISH_MAX_BYTES) {
    return c.json({ error: 'document too large' }, 413);
  }

  let published;
  try {
    published = createSnapshot(text);
  } catch (err) {
    if (err instanceof SnapshotCapError) {
      return c.json({ error: 'snapshot capacity reached' }, 507);
    }
    throw err;
  }
  const { snapshot, writeToken } = published;
  return c.json({
    id: snapshot.id,
    writeToken,
    url: `/d/${snapshot.id}`,
    rawUrl: `/d/${snapshot.id}.txt`,
  });
});

// Raw view: text/plain verbatim canonical bytes. Registered BEFORE the HTML
// route so the literal `.txt` suffix wins over the bare `:id` match. Accepts
// `?raw=1` (no-op alias) and `?items=t-a,t-b` for a scoped subset.
app.get('/d/:id{.+\\.txt}', (c) => {
  // The matched param still carries the `.txt` suffix; strip it back to the id.
  const raw = c.req.param('id');
  const id = raw.endsWith('.txt') ? raw.slice(0, -4) : raw;
  const snap = getSnapshot(id);
  if (!snap) return c.text('not found', 404);

  const itemsParam = c.req.query('items');
  let text = snap.text;
  if (itemsParam) {
    const items = new Set(
      itemsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (items.size > 0) text = scopeText(snap.text, items);
  }

  // A shared list is private data: don't let a proxy sniff the type, cache it,
  // or a crawler index it. Keep the canonical Content-Type/Disposition.
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Content-Disposition', 'inline');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex');
  return c.body(text);
});

// Human view: quiet read-only HTML render of the snapshot. All user text is
// escaped; metadata stays inline mute-ink text (no chips/badges), 1px hairlines.
app.get('/d/:id', (c) => {
  const id = c.req.param('id');
  const snap = getSnapshot(id);
  if (!snap) return c.html(renderNotFound(), 404);
  return c.html(renderDoc(snap.id, snap.text));
});

// Unpublish: remove a snapshot. Requires the snapshot's write token.
app.delete('/api/d/:id', (c) => {
  const id = c.req.param('id');
  const snap = getSnapshot(id);
  if (!snap) return c.json({ error: 'not found' }, 404);
  if (!checkWriteToken(presentedWriteToken(c), snap.writeTokenHash)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  deleteSnapshot(id);
  return c.json({ ok: true });
});

// JSON write-back: append CriticMarkup comments anchored by ^id, OR accept a
// whole annotated doc and merge it via the safe paste round-trip. Requires the
// snapshot's write token — the read url alone is read-only.
app.post('/api/d/:id/comments', async (c) => {
  const id = c.req.param('id');
  const snap = getSnapshot(id);
  if (!snap) return c.json({ error: 'not found' }, 404);
  if (!checkWriteToken(presentedWriteToken(c), snap.writeTokenHash)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > COMMENTS_MAX_BYTES) {
    return c.json({ error: 'comment too large' }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  // Path A: a re-emitted annotated doc -> validate + merge by ^id.
  const annotatedText = (body as { annotatedText?: unknown } | null)?.annotatedText;
  if (typeof annotatedText === 'string') {
    const result = mergeAnnotated(snap.text, annotatedText);
    if (!result.ok || result.mergedText === undefined) {
      return c.json({ ok: false, rejectedReason: result.rejectedReason ?? 'rejected' }, 422);
    }
    putSnapshot(snap.id, result.mergedText);
    return c.json({ ok: true, addedComments: result.addedComments ?? 0 });
  }

  // Path B: a JSON array of comments -> append each as inline CriticMarkup on
  // the matching task line.
  if (Array.isArray(body)) {
    const result = appendComments(snap.text, body as unknown[]);
    if (!result.ok) return c.json({ ok: false, rejectedReason: result.reason }, 422);
    putSnapshot(snap.id, result.text);
    return c.json({ ok: true, addedComments: result.added });
  }

  return c.json(
    { ok: false, rejectedReason: 'expected { annotatedText } or a JSON array of comments' },
    422,
  );
}); // /api/d/:id/comments

// --- Sync API (single shared doc) -----------------------------------------

app.route('/api/doc', docApp);
app.route('/api/notes', notesApp);
app.route('/api/notes-attachments', attachmentsApp);

// --- Comment append (JSON array -> inline CriticMarkup) -------------------

interface CommentInput {
  itemId: string;
  body: string;
  author?: string;
  kind?: 'comment' | 'insert' | 'delete' | 'substitute' | 'highlight';
}

const OPEN: Record<NonNullable<CommentInput['kind']>, string> = {
  comment: '{>>',
  insert: '{++',
  delete: '{--',
  substitute: '{~~',
  highlight: '{==',
};
const CLOSE: Record<NonNullable<CommentInput['kind']>, string> = {
  comment: '<<}',
  insert: '++}',
  delete: '--}',
  substitute: '~~}',
  highlight: '==}',
};

/** Build one CriticMarkup block. Comments carry the `@author: body` head; the
 *  edit-ops carry the bare body. Delimiter chars in the body are neutralised so
 *  the block can't be broken or the doc corrupted. */
function critic(c: CommentInput): string {
  const kind = c.kind ?? 'comment';
  const safeBody = c.body.replace(/[{}]/g, ' ').trim();
  const inner =
    kind === 'comment'
      ? // Only prepend an `@author: ` head when an author is present; an
        // author-less comment is just the bare body (no stray leading colon).
        c.author
        ? `@${c.author}: ${safeBody}`.trim()
        : safeBody
      : safeBody;
  return `${OPEN[kind]} ${inner} ${CLOSE[kind]}`;
}

function appendComments(
  text: string,
  raw: unknown[],
): { ok: true; text: string; added: number } | { ok: false; reason: string } {
  const inputs: CommentInput[] = [];
  for (const r of raw) {
    const o = r as Partial<CommentInput> | null;
    if (!o || typeof o.itemId !== 'string' || typeof o.body !== 'string') {
      return { ok: false, reason: 'each comment needs { itemId: string, body: string }' };
    }
    inputs.push({
      itemId: o.itemId,
      body: o.body,
      author: typeof o.author === 'string' ? o.author : undefined,
      kind: o.kind,
    });
  }

  const doc = parse(text);
  // Index task nodes by id for O(1) anchoring.
  const byId = new Map<string, TaskNode>();
  for (const n of doc.nodes) {
    if (n.type === 'task' && n.id) byId.set(n.id, n);
  }

  let added = 0;
  for (const input of inputs) {
    const task = byId.get(input.itemId);
    if (!task) return { ok: false, reason: `no task with ^${input.itemId}` };
    // Append the critic block as a new body segment so serialize() re-emits a
    // canonical line with the comment before the trailing ^id.
    task.segments.push({ kind: 'critic', raw: critic(input), critic: input.kind ?? 'comment' });
    added++;
  }

  // Re-serialize node-by-node so untouched lines stay byte-identical.
  const merged = doc.nodes.map(serializeNode).join('\n');
  return { ok: true, text: merged, added };
}

// --- HTML rendering -------------------------------------------------------

const PAGE_CSS = `
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#07080a;color:#cdcdcd;
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:48px 24px 96px}
  .doc-title{font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:500;
    letter-spacing:.04em;text-transform:uppercase;color:#6a6b6c;margin:0 0 24px}
  h1,h2,h3{font-family:Inter,system-ui,sans-serif;color:#f4f4f6;letter-spacing:-.01em}
  h1{font-size:28px;margin:0 0 16px}
  h2{font-size:20px;margin:32px 0 8px}
  ul{list-style:none;margin:0;padding:0}
  li{display:flex;gap:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08)}
  .box{color:#6a6b6c;user-select:none;flex:0 0 auto}
  .body{flex:1 1 auto}
  .done .body{color:#6a6b6c;text-decoration:line-through}
  .meta{color:#9c9c9d;font-size:13px}
  .tag,.ctx{color:#57c1ff}
  .pri{color:#c2706a}
  .note{color:#9c9c9d;font-style:italic}
  .critic{color:#c2706a}
  a{color:#57c1ff}
  .empty{color:#6a6b6c}
`;

const STATE_BOX: Record<string, string> = {
  open: '[ ]',
  done: '[x]',
  doing: '[/]',
  cancelled: '[-]',
  deferred: '[>]',
};

function segHtml(s: TaskNode['segments'][number]): string {
  const raw = escapeHtml(s.raw);
  switch (s.kind) {
    case 'tag':
      return `<span class="tag">${raw}</span>`;
    case 'context':
      return `<span class="ctx">${raw}</span>`;
    case 'priority':
      return `<span class="pri">${raw}</span>`;
    case 'critic':
      return `<span class="critic">${raw}</span>`;
    case 'link':
      // target is user-supplied; only allow http(s)/mailto to avoid javascript: URLs.
      if (s.target && /^(https?:|mailto:)/i.test(s.target)) {
        return `<a href="${escapeHtml(s.target)}" rel="noopener noreferrer nofollow">${escapeHtml(
          s.label || s.target,
        )}</a>`;
      }
      return raw;
    default:
      return raw;
  }
}

function taskHtml(t: TaskNode): string {
  const cls = t.state === 'done' || t.state === 'cancelled' ? ' class="done"' : '';
  const box = escapeHtml(STATE_BOX[t.state] ?? '[ ]');
  const body = t.segments.map(segHtml).join(' ');
  const indent = t.depth > 0 ? ` style="margin-left:${t.depth * 20}px"` : '';
  return `<li${cls}${indent}><span class="box">${box}</span><span class="body">${
    body || '&nbsp;'
  }</span></li>`;
}

/** Render one node to a block. `tag: 'heading'` is a list-breaking sibling that
 *  lives OUTSIDE any <ul>; `tag: 'li'` is a list item to be grouped into a <ul>;
 *  `tag: 'skip'` (blanks) contributes nothing. */
type Block = { tag: 'heading' | 'li' | 'skip'; html: string };

function nodeBlock(node: Node): Block {
  if (node.type === 'task') return { tag: 'li', html: taskHtml(node) };
  const raw = node.raw;
  switch (node.type) {
    case 'heading': {
      const level = raw.match(/^#+/)?.[0].length ?? 1;
      const tag = level >= 2 ? 'h2' : 'h1';
      return { tag: 'heading', html: `<${tag}>${escapeHtml(raw.replace(/^#+\s*/, ''))}</${tag}>` };
    }
    case 'note':
      return {
        tag: 'li',
        html: `<li class="note"><span class="body">${escapeHtml(raw.trim())}</span></li>`,
      };
    case 'comment':
      return {
        tag: 'li',
        html: `<li class="critic"><span class="body">${escapeHtml(raw.trim())}</span></li>`,
      };
    case 'blank':
      return { tag: 'skip', html: '' };
    default:
      return { tag: 'li', html: `<li><span class="body">${escapeHtml(raw)}</span></li>` };
  }
}

function renderDoc(id: string, text: string): string {
  const { nodes } = parse(text);
  // Render a FLAT sequence of blocks: consecutive list-items are grouped into
  // their own <ul>, headings are emitted as siblings OUTSIDE any list. This
  // keeps the markup valid — no <h*> child of a <ul>, and no empty <ul></ul>.
  const out: string[] = [];
  let listItems: string[] = [];
  const flushList = (): void => {
    if (listItems.length > 0) {
      out.push(`<ul>${listItems.join('\n')}</ul>`);
      listItems = [];
    }
  };
  for (const node of nodes) {
    const block = nodeBlock(node);
    if (block.tag === 'li') {
      listItems.push(block.html);
    } else if (block.tag === 'heading') {
      flushList();
      out.push(block.html);
    }
    // 'skip' (blanks) contribute nothing and do not break a run.
  }
  flushList();

  const safeId = escapeHtml(id);
  const body = out.length > 0 ? out.join('\n') : `<p class="empty">This document is empty.</p>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Rune · ${safeId}</title>
<style>${PAGE_CSS}</style>
</head><body><div class="wrap">
<p class="doc-title">Rune · shared · <a href="/d/${safeId}.txt">raw</a></p>
${body}
</div></body></html>`;
}

function renderNotFound(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Rune · not found</title>
<style>${PAGE_CSS}</style>
</head><body><div class="wrap">
<h1>Not found</h1>
<p class="empty">No shared document lives at this link.</p>
</div></body></html>`;
}

// --- Static app (dist/web) -------------------------------------------------
//
// Served AFTER the API/share routes so those win. serveStatic's root is
// relative to the process CWD (absolute paths are unsupported), so we compute a
// relative path to the build. A GET that matches no real file and isn't an
// /api/* or /d/* route falls back to index.html (SPA routing).

const distAbs = (() => {
  const override = process.env.RUNE_STATIC_DIR;
  if (override && override !== '') {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  return fileURLToPath(new URL('../dist/web', import.meta.url));
})();
const staticRoot = relative(process.cwd(), distAbs) || '.';

app.get(
  '/*',
  serveStatic({
    root: staticRoot,
    onFound: (_path, c) => {
      const p = c.req.path;
      if (p.startsWith('/assets/')) {
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // index.html, sw.js, manifest, icons — always revalidate so a new
        // deploy's shell wins; the SW owns real offline caching.
        c.header('Cache-Control', 'no-cache');
      }
    },
  }),
);

// SPA fallback: any non-file GET that isn't an API/share path serves index.html.
app.get('*', (c) => {
  const p = c.req.path;
  if (p.startsWith('/api/') || p.startsWith('/d/')) return c.text('not found', 404);
  // A path that looks like a file (has an extension) but wasn't found is a 404,
  // not the SPA shell — mirrors the old vercel.json rewrite exclusion.
  if (/\.[a-zA-Z0-9]+$/.test(p)) return c.text('not found', 404);
  try {
    const html = readFileSync(join(distAbs, 'index.html'), 'utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.html(html);
  } catch {
    return c.text('not found', 404);
  }
});

// --- Boot -----------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787);
// Bind loopback only: `tailscale serve` proxies HTTPS in front of us.
const hostname = process.env.RUNE_HOST ?? '127.0.0.1';

// Only listen when run directly (so importing the app in tests is side-effect
// free). tsx runs this as the entry module.
if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port, hostname });
  // eslint-disable-next-line no-console
  console.log(`Rune server listening on http://${hostname}:${port}`);
  if (!existsSync(join(distAbs, 'index.html'))) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rune] no built app at ${distAbs} — run \`pnpm build:web\` (API + share still work).`,
    );
  }
}

export { app };
