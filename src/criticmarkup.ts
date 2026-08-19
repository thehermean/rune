// CriticMarkup comments — Wave 2 / M5 part 1.
//
// Comments are CriticMarkup blocks anchored to stable ^ids, never line numbers.
// Each block carries a metadata head CriticMarkup itself lacks:
//   {>> @ai[id=c-01 ts=… reply=c-00 resolved]: body that may reference [[t-…]] <<}
// `@author` = attribution (@ai distinguished from humans); `id` + `reply` = a
// threaded tree; `resolved` collapses. Each block stays within a single item.
//
// Two source forms feed this:
//   (a) a `critic` Segment on a task line -> anchored to that task's ^id.
//   (b) a standalone `comment` RawNode (a line opening with `{>>` etc.) ->
//       anchored to the nearest PRECEDING task line's ^id.
// Edit-ops {++ x ++} / {-- x --} / {~~ a~>b ~~} parse to insert/delete/
// substitute with `body` set to the inner text. commentsFor filters to one item.

import type { Doc, Node } from './types';

export type Author = string;

export interface Comment {
  commentId: string;
  author: Author;
  reply?: string;
  resolved?: boolean;
  body: string;
  /** The ^id of the item this comment anchors to, or null if unanchored. */
  itemId: string | null;
  kind: 'comment' | 'insert' | 'delete' | 'substitute' | 'highlight';
}

const CRITIC_OPEN: Record<string, Comment['kind']> = {
  '>>': 'comment',
  '++': 'insert',
  '--': 'delete',
  '~~': 'substitute',
  '==': 'highlight',
};

const CRITIC_CLOSE: Record<string, string> = {
  '>>': '<<}',
  '++': '++}',
  '--': '--}',
  '~~': '~~}',
  '==': '==}',
};

// Head: `@author[id=c-01 reply=c-00 resolved]: body`. Everything before the
// optional `:` is the metadata head; the remainder is the body. The bracketed
// attribute block and the `@author` token are both optional so a bare
// `{>> just a note <<}` still parses (author empty, body = "just a note").
const HEAD_RE = /^\s*(?:@([^\s[\]]+))?\s*(?:\[([^\]]*)\])?\s*(?::\s*([\s\S]*))?$/;

let auto = 0;

/** Parse the inner text of a `{>> … <<}` (or edit-op) block into a Comment. */
function parseBlock(inner: string, kind: Comment['kind'], itemId: string | null): Comment {
  // Edit-ops carry no metadata head: the whole inner text is the body.
  if (kind !== 'comment') {
    return {
      commentId: `op-${++auto}`,
      author: '',
      body: inner.trim(),
      itemId,
      kind,
    };
  }

  // A comment head exists only when the block has a `:` separating an optional
  // `@author` / `[...]` attribute block from the body. A bare `{>> a note <<}`
  // (no leading colon-terminated head) keeps its whole inner text as the body.
  const hasHead = /^\s*(?:@[^\s[\]]+)?\s*(?:\[[^\]]*\])?\s*:/.test(inner);

  let author = '';
  let attrs = '';
  let body = inner.trim();

  if (hasHead) {
    const m = inner.match(HEAD_RE);
    if (m) {
      author = m[1] ?? '';
      attrs = m[2] ?? '';
      body = (m[3] ?? '').trim();
    }
  }

  const parsed = parseAttrs(attrs);
  return {
    // An EMPTY id= (e.g. `[id=]`) is treated like a missing id: fall through to
    // the auto-generated `c-N` so two empty-id comments still get DISTINCT ids.
    commentId: parsed.id || `c-${++auto}`,
    author,
    reply: parsed.reply,
    resolved: parsed.resolved,
    body,
    itemId,
    kind,
  };
}

interface Attrs {
  id?: string;
  reply?: string;
  resolved?: boolean;
}

/** Parse `id=c-01 reply=c-00 resolved` (space-separated, flags bare). */
function parseAttrs(attrs: string): Attrs {
  const out: Attrs = {};
  for (const tok of attrs.split(/\s+/).map((s) => s.trim()).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq === -1) {
      if (tok === 'resolved') out.resolved = true;
      continue;
    }
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    if (key === 'id') out.id = val;
    else if (key === 'reply') out.reply = val;
    else if (key === 'resolved') out.resolved = val !== 'false';
  }
  return out;
}

/** Strip the `{>>`/`<<}` (or edit-op) delimiters, returning the inner text. */
function unwrap(raw: string): { inner: string; kind: Comment['kind'] } | null {
  const opener = raw.slice(1, 3);
  const kind = CRITIC_OPEN[opener];
  const close = CRITIC_CLOSE[opener];
  if (!kind || !close || raw[0] !== '{') return null;
  // A block with no matching closer is NOT a comment: returning inner here would
  // mint a phantom empty auto-id comment for an unclosed `{>>`. Require the
  // closer to sit strictly after the 3-char opener.
  const end = raw.lastIndexOf(close);
  if (end < 3) return null;
  return { inner: raw.slice(3, end), kind };
}

/** Extract every `{…}` block out of a standalone comment line, in order. */
function blocksInLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === '{' && CRITIC_OPEN[line.slice(i + 1, i + 3)]) {
      const close = CRITIC_CLOSE[line.slice(i + 1, i + 3)];
      const end = line.indexOf(close, i + 3);
      if (end !== -1) {
        out.push(line.slice(i, end + close.length));
        i = end + close.length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Every comment in the document, in source order. */
export function comments(doc: Doc): Comment[] {
  auto = 0;
  const out: Comment[] = [];
  let lastTaskId: string | null = null;

  for (const node of doc.nodes as Node[]) {
    if (node.type === 'task') {
      lastTaskId = node.id;
      for (const seg of node.segments) {
        if (seg.kind !== 'critic') continue;
        const u = unwrap(seg.raw);
        if (!u) continue;
        out.push(parseBlock(u.inner, u.kind, node.id));
      }
    } else if (node.type === 'comment') {
      // A standalone CriticMarkup line: anchor to the nearest preceding task.
      for (const raw of blocksInLine(node.raw)) {
        const u = unwrap(raw);
        if (!u) continue;
        out.push(parseBlock(u.inner, u.kind, lastTaskId));
      }
    }
  }
  return out;
}

/** Comments anchored to one item. */
export function commentsFor(doc: Doc, itemId: string): Comment[] {
  return comments(doc).filter((c) => c.itemId === itemId);
}
