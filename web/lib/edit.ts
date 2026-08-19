// Pure Doc transforms for the editing layer.
//
// Every function here takes a Doc (from @core) and returns a NEW Doc — the input
// is NEVER mutated. No React, no store, no IO: these are total, defensive, and
// unit-testable in plain node/vitest. The store wires them to undo/redo +
// autosave; the .rune TEXT stays canonical (parse -> transform -> serialize).
//
// "Descendant block" model: a task owns the run of following nodes that are MORE
// indented than it. The run ends at the first following node, at the SAME-or-
// shallower indent, that is a task or a heading (the next structural sibling or
// section). Notes/comments at the same indent are still treated as part of the
// block (they hang under the task), so only a task/heading boundary stops it.

import type { Doc, Node, TaskNode } from '@core';
import { parse, ID_BODY } from '@core';
import { comments as docComments } from '@core/criticmarkup';

/** Index of the task node with `id`, or -1 if there is no such task. */
export function indexById(doc: Doc, id: string): number {
  return doc.nodes.findIndex((n) => n.type === 'task' && n.id === id);
}

/** The indent of any node (raw nodes may omit it -> treated as 0). */
function indentOf(node: Node): number {
  if (node.type === 'task') return node.indent;
  return node.indent ?? 0;
}

/** A node that closes a descendant block: a task or a heading. */
function isStructural(node: Node): boolean {
  return node.type === 'task' || node.type === 'heading';
}

/**
 * The exclusive end index of the task-at-`taskIdx` descendant block: the first
 * index AFTER the task itself and all of its owned descendant nodes. Scans
 * forward, consuming nodes that are more indented than the task; stops at the
 * first task/heading at the same-or-shallower indent. Non-structural nodes
 * (blank/note/comment/text) never stop the scan — they are swept along.
 */
export function descendantEndIndex(doc: Doc, taskIdx: number): number {
  const nodes = doc.nodes;
  const task = nodes[taskIdx];
  if (!task || task.type !== 'task') return taskIdx + 1;
  const baseIndent = task.indent;

  let end = taskIdx + 1;
  while (end < nodes.length) {
    const node = nodes[end];
    if (isStructural(node) && indentOf(node) <= baseIndent) break;
    end++;
  }
  return end;
}

/**
 * The start index of the PREVIOUS sibling block of the task at `taskIdx` — the
 * nearest preceding task at the SAME indent whose block ends exactly at
 * `taskIdx`. Scans backwards over the task's own block start: any task at a
 * SHALLOWER indent is an ancestor (a parent/section boundary), so there is no
 * previous sibling and this returns -1. A heading at the same-or-shallower
 * indent is a SECTION boundary — there is no previous sibling across it (mirrors
 * descendantEndIndex, which likewise breaks at a heading, so up/down stay
 * symmetric and a task can never jump/orphan its section heading). A task at the
 * same indent is the previous sibling; its block starts at that index. Deeper
 * tasks and non-structural nodes belong to that sibling's block and are skipped.
 */
function prevSiblingStart(doc: Doc, taskIdx: number): number {
  const nodes = doc.nodes;
  const task = nodes[taskIdx];
  if (!task || task.type !== 'task') return -1;
  const baseIndent = task.indent;

  for (let i = taskIdx - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!isStructural(node)) continue; // notes/comments/blank hang under a task
    const indent = indentOf(node);
    if (indent < baseIndent) return -1; // an ancestor/section — no prev sibling
    if (node.type === 'heading' && indent <= baseIndent) return -1; // section boundary
    if (node.type === 'task' && indent === baseIndent) return i; // the sibling
    // A deeper task belongs to a sibling's block; keep scanning back toward that
    // sibling's own start.
  }
  return -1;
}

/**
 * Move the task at `id` AND its whole descendant block past the adjacent sibling
 * block at the same indent: before the PREVIOUS sibling ("up") or after the NEXT
 * sibling ("down"). A sibling is the nearest task at the same indent whose block
 * abuts this one. No-op (a fresh Doc, never mutated) at the ends of the sibling
 * run or for an unknown id.
 */
export function moveBlock(doc: Doc, id: string, dir: 'up' | 'down'): Doc {
  const idx = indexById(doc, id);
  if (idx === -1) return { nodes: doc.nodes.slice() };
  const end = descendantEndIndex(doc, idx); // exclusive end of this block

  if (dir === 'up') {
    const prevStart = prevSiblingStart(doc, idx);
    if (prevStart === -1) return { nodes: doc.nodes.slice() };
    const nodes = doc.nodes.slice();
    const block = nodes.splice(idx, end - idx); // lift this block out
    nodes.splice(prevStart, 0, ...block); // reinsert before the previous sibling
    return { nodes };
  }

  // down: the next sibling block starts exactly at `end` (if it is a sibling).
  const nextIdx = end;
  const nextNode = doc.nodes[nextIdx];
  if (!nextNode || nextNode.type !== 'task' || nextNode.indent !== (doc.nodes[idx] as TaskNode).indent) {
    return { nodes: doc.nodes.slice() };
  }
  const nextEnd = descendantEndIndex(doc, nextIdx); // exclusive end of next block
  const nodes = doc.nodes.slice();
  const block = nodes.splice(idx, end - idx); // lift this block out
  // After removing this block, the next block shifts left by its length; its new
  // end index is nextEnd - (end - idx). Insert this block right after it.
  nodes.splice(nextEnd - (end - idx), 0, ...block);
  return { nodes };
}

/**
 * True when the same-indent tasks at `aIdx` and `bIdx` belong to the SAME
 * contiguous sibling run — no heading (at same-or-shallower indent) and no
 * shallower task lies between them. Deeper tasks between them are fine (they are
 * the intervening siblings' own descendants).
 */
function sameSiblingRun(doc: Doc, aIdx: number, bIdx: number): boolean {
  const lo = Math.min(aIdx, bIdx);
  const hi = Math.max(aIdx, bIdx);
  const baseIndent = indentOf(doc.nodes[lo]);
  for (let i = lo + 1; i < hi; i++) {
    const n = doc.nodes[i];
    if (!isStructural(n)) continue;
    const ind = indentOf(n);
    if (n.type === 'heading' && ind <= baseIndent) return false; // crosses a section
    if (n.type === 'task' && ind < baseIndent) return false; // crosses an ancestor
  }
  return true;
}

/**
 * Move the task at `sourceId` AND its whole descendant block to sit immediately
 * `place` ('before' | 'after') the block of `targetId`. Reordering is confined
 * to genuine siblings: source and target must share the SAME indent and the SAME
 * contiguous sibling run (never crossing a heading/section or a shallower task —
 * the same guarantee moveBlock gives), so indentation is preserved and nothing
 * is re-parented or orphaned from its heading. Any of these is a no-op (a fresh
 * Doc, never mutated): unknown id, a target inside the source's own block, a
 * different indent, or a different sibling run.
 */
export function moveBlockTo(
  doc: Doc,
  sourceId: string,
  targetId: string,
  place: 'before' | 'after',
): Doc {
  const srcIdx = indexById(doc, sourceId);
  const tgtIdx = indexById(doc, targetId);
  if (srcIdx === -1 || tgtIdx === -1) return { nodes: doc.nodes.slice() };

  const srcEnd = descendantEndIndex(doc, srcIdx);
  // Dropping onto the source itself or into its own descendant block is a no-op.
  if (tgtIdx >= srcIdx && tgtIdx < srcEnd) return { nodes: doc.nodes.slice() };

  const src = doc.nodes[srcIdx] as TaskNode;
  const tgt = doc.nodes[tgtIdx] as TaskNode;
  if (tgt.indent !== src.indent) return { nodes: doc.nodes.slice() };
  if (!sameSiblingRun(doc, srcIdx, tgtIdx)) return { nodes: doc.nodes.slice() };

  const len = srcEnd - srcIdx;
  let tgtEnd = descendantEndIndex(doc, tgtIdx);
  // Inserting 'after' lands past the target's whole block — but don't step past
  // trailing blank-line spacing swept into it, or repeated reordering would
  // accumulate blank lines before the moved task.
  if (place === 'after') {
    while (tgtEnd > tgtIdx + 1 && doc.nodes[tgtEnd - 1].type === 'blank') tgtEnd--;
  }
  const nodes = doc.nodes.slice();
  const block = nodes.splice(srcIdx, len); // lift the source block out

  // Insertion point in the POST-removal array. 'before' -> the target's start;
  // 'after' -> just past the target's (blank-trimmed) block. If the source sat
  // before the target, every later index shifted left by the block length.
  let insertAt = place === 'before' ? tgtIdx : tgtEnd;
  if (srcIdx < tgtIdx) insertAt -= len;
  nodes.splice(insertAt, 0, ...block);
  return { nodes };
}

/**
 * Remove a task line AND its descendant block. Unknown id -> doc unchanged
 * (a fresh Doc with the same nodes, so the return is always a new object).
 */
export function removeTask(doc: Doc, id: string): Doc {
  const idx = indexById(doc, id);
  if (idx === -1) return { nodes: doc.nodes.slice() };
  const end = descendantEndIndex(doc, idx);
  const nodes = doc.nodes.slice();
  nodes.splice(idx, end - idx);
  return { nodes };
}

/**
 * Replace the BODY of a task (everything after `- [state] ` and before the
 * trailing ` ^id`) by re-parsing a freshly built line. The original stateChar,
 * indent, and id are PRESERVED; any trailing `^id` the caller left in `body` is
 * stripped (the id comes from the original node, never the new body). Unknown
 * id -> doc unchanged.
 */
export function replaceBody(doc: Doc, id: string, body: string): Doc {
  const idx = indexById(doc, id);
  if (idx === -1) return { nodes: doc.nodes.slice() };
  const original = doc.nodes[idx] as TaskNode;

  const cleanBody = stripTrailingId(body).trim();
  const indent = ' '.repeat(original.indent);
  // Re-parse the rebuilt line so segments are derived by @core, not hand-rolled.
  const line = `${indent}- [${original.stateChar}] ${cleanBody}`.trimEnd();
  const parsed = parse(line);
  const reparsed = parsed.nodes.find((n): n is TaskNode => n.type === 'task');
  if (!reparsed) return { nodes: doc.nodes.slice() };

  // Preserve the locked fields off the original.
  const next: TaskNode = {
    ...reparsed,
    indent: original.indent,
    depth: original.depth,
    state: original.state,
    stateChar: original.stateChar,
    id: original.id,
  };

  const nodes = doc.nodes.slice();
  nodes[idx] = next;
  return { nodes };
}

/**
 * Insert a fully-formed task line one level deeper than `parentId` (indent =
 * parent.indent + 2), positioned right AFTER the parent's descendant block.
 * `line` is a complete `- [ ] body ^id` string built by the caller. The line is
 * re-parsed and re-indented to the child depth. Unknown parent -> doc unchanged.
 */
export function insertChild(doc: Doc, parentId: string, line: string): Doc {
  const idx = indexById(doc, parentId);
  if (idx === -1) return { nodes: doc.nodes.slice() };
  const parent = doc.nodes[idx] as TaskNode;
  const node = taskNodeFromLine(line, parent.indent + 2);
  if (!node) return { nodes: doc.nodes.slice() };

  const at = descendantEndIndex(doc, idx);
  const nodes = doc.nodes.slice();
  nodes.splice(at, 0, node);
  return { nodes };
}

/**
 * Insert a fully-formed task line at the SAME indent as `afterId`, after
 * afterId's descendant block. `line` is a complete `- [ ] body ^id` string.
 * Unknown afterId -> doc unchanged.
 */
export function insertSibling(doc: Doc, afterId: string, line: string): Doc {
  const idx = indexById(doc, afterId);
  if (idx === -1) return { nodes: doc.nodes.slice() };
  const sibling = doc.nodes[idx] as TaskNode;
  const node = taskNodeFromLine(line, sibling.indent);
  if (!node) return { nodes: doc.nodes.slice() };

  const at = descendantEndIndex(doc, idx);
  const nodes = doc.nodes.slice();
  nodes.splice(at, 0, node);
  return { nodes };
}

// --- internal helpers --------------------------------------------------------

// Unified on @core's ID_BODY so the caret-id shape lives in ONE place. Requiring
// the `t-` prefix stops `stripTrailingId` eating a caret-word like the `^2` in
// "raise to ^2" (which must stay title text). The `(?:^|\s+)` alt also matches a
// body that is nothing but the id (e.g. a stray `^t-bogus`).
const TRAILING_ID_RE = new RegExp(`(?:^|\\s+)\\^${ID_BODY}\\s*$`);

/** Drop a trailing ` ^id` from a body string (the id is preserved elsewhere). */
function stripTrailingId(body: string): string {
  return body.replace(TRAILING_ID_RE, '');
}

/**
 * Parse a complete task line string into a TaskNode, re-indented to `indent`
 * (and the matching depth). Returns null if the line is not a task.
 */
function taskNodeFromLine(line: string, indent: number): TaskNode | null {
  const parsed = parse(line.replace(/^\s+/, ''));
  const node = parsed.nodes.find((n): n is TaskNode => n.type === 'task');
  if (!node) return null;
  return { ...node, indent, depth: Math.floor(indent / 2) };
}

// --- comments (CriticMarkup) -------------------------------------------------
//
// A comment is a STANDALONE CriticMarkup line: `<indent>{>> @author[…]: body <<}`.
// It anchors to a task by being the nearest-FOLLOWING line under a task line —
// criticmarkup.comments() walks nodes top-to-bottom and attributes each
// standalone comment line to the most-recent preceding task. So to anchor a new
// comment to a task we insert it after the task line and after any note/comment
// lines already hanging under it (keeping the existing thread contiguous).

/** Options for {@link insertComment}. */
export interface InsertCommentOptions {
  author: string;
  commentId: string;
  reply?: string;
  resolved?: boolean;
  body: string;
}

/**
 * Build the bracketed attribute head for a comment line:
 * `[id=c-1 reply=c-0 resolved]`. Always carries an id; reply/resolved are added
 * only when present. id/reply are sanitized so a stray space/`]`/newline cannot
 * break out of the `[…]` block (criticmarkup parses attrs as space-separated
 * tokens inside the first `[…]`).
 */
function commentHead(opts: InsertCommentOptions): string {
  const parts = [`id=${sanitizeCommentToken(opts.commentId)}`];
  if (opts.reply) parts.push(`reply=${sanitizeCommentToken(opts.reply)}`);
  if (opts.resolved) parts.push('resolved');
  return `[${parts.join(' ')}]`;
}

/**
 * Neutralise a structural comment token (id / reply / author) so it cannot break
 * the delimiter-sensitive comment line. The criticmarkup head parses `@author`
 * as a run with no whitespace/`[`/`]` and the bracketed attrs as space-separated
 * tokens, so any whitespace (incl. newlines), `[`, `]`, `:`, or `@` in these
 * fields would split the line, corrupt anchoring, or inject a fake node. Strip
 * those characters — legal tokens (`c-1`, `ai`, `ben`) are left byte-identical.
 */
function sanitizeCommentToken(token: string): string {
  return token.replace(/[\s[\]:@{}]/g, '');
}

/**
 * Neutralise a comment body so it cannot break the `{>> … <<}` delimiters:
 * collapse all whitespace/newlines to single spaces and defuse any literal
 * `<<}` (which would close the block early) or `{>>` (which would open a nested
 * one). A defused sequence keeps its glyphs but gains a hairline space so it no
 * longer matches the delimiter.
 */
function sanitizeCommentBody(body: string): string {
  return body
    .replace(/\s+/g, ' ')
    .replace(/<<\}/g, '<< }')
    .replace(/\{>>/g, '{ >>')
    .trim();
}

/**
 * The exclusive end index of the run of note/comment/blank lines hanging
 * directly under the task at `taskIdx` — i.e. where a NEW comment line should be
 * inserted so it still anchors to this task. Stops at the first task/heading/
 * text node (a new structural element), regardless of indent. Trailing blank
 * lines inside the run are NOT consumed (the comment is placed before them).
 */
function commentInsertIndex(doc: Doc, taskIdx: number): number {
  const nodes = doc.nodes;
  let end = taskIdx + 1;
  let lastAnchor = end; // index just past the last note/comment seen
  while (end < nodes.length) {
    const node = nodes[end];
    if (node.type === 'note' || node.type === 'comment') {
      end++;
      lastAnchor = end;
      continue;
    }
    if (node.type === 'blank') {
      end++;
      continue; // a blank may sit inside the thread; keep scanning
    }
    break; // a task / heading / text node ends the thread region
  }
  return lastAnchor;
}

/**
 * Insert a standalone CriticMarkup comment line anchored to task `itemId`.
 * The line is indented to `task.indent + 2` and placed immediately AFTER the
 * task and any note/comment lines already under it, so criticmarkup.comments()
 * attributes it to this task. Unknown id / empty body -> doc unchanged (a fresh
 * Doc object).
 */
export function insertComment(doc: Doc, itemId: string, opts: InsertCommentOptions): Doc {
  const idx = indexById(doc, itemId);
  if (idx === -1) return { nodes: doc.nodes.slice() };
  const body = sanitizeCommentBody(opts.body);
  if (!body) return { nodes: doc.nodes.slice() };
  if (!opts.commentId.trim()) return { nodes: doc.nodes.slice() };

  const task = doc.nodes[idx] as TaskNode;
  const indent = ' '.repeat(task.indent + 2);
  // Sanitizing can EMPTY the author (e.g. it was only illegal chars). An empty
  // author emits `@[id=…]` which HEAD_RE cannot parse — the head leaks into the
  // body and the assigned commentId is lost. Fall back to a default author so the
  // head always parses and the id survives.
  const author = sanitizeCommentToken(opts.author) || 'me';
  const raw = `${indent}{>> @${author}${commentHead(opts)}: ${body} <<}`;
  const node: Node = { type: 'comment', raw, indent: task.indent + 2 };

  const at = commentInsertIndex(doc, idx);
  const nodes = doc.nodes.slice();
  nodes.splice(at, 0, node);
  return { nodes };
}

/**
 * The doc-node index of the standalone comment line carrying `commentId`, or -1.
 * Only standalone `comment` nodes are rewritable byte-for-byte; an inline critic
 * segment on a task line is not addressed here.
 */
export function commentNodeIndex(doc: Doc, commentId: string): number {
  const target = commentId.trim();
  if (!target) return -1;
  return doc.nodes.findIndex(
    (n) => n.type === 'comment' && rawCarriesCommentId(n.raw, target),
  );
}

/** True if a standalone comment line's raw text carries `[… id=<commentId> …]`. */
function rawCarriesCommentId(raw: string, commentId: string): boolean {
  const m = raw.match(/\[([^\]]*)\]/);
  if (!m) return false;
  return m[1].split(/\s+/).some((tok) => tok === `id=${commentId}`);
}

/**
 * Add or remove the bare `resolved` attribute inside the `[…]` head of the
 * comment line carrying `commentId`, leaving everything else byte-identical.
 * Unknown id (or an inline-only comment) -> doc unchanged (a fresh Doc object).
 */
export function setCommentResolved(doc: Doc, commentId: string, resolved: boolean): Doc {
  const idx = commentNodeIndex(doc, commentId);
  if (idx === -1) return { nodes: doc.nodes.slice() };
  const node = doc.nodes[idx];
  if (node.type !== 'comment') return { nodes: doc.nodes.slice() };

  const nextRaw = node.raw.replace(/\[([^\]]*)\]/, (_full, inner: string) => {
    const toks = inner.split(/\s+/).filter(Boolean);
    const has = toks.includes('resolved');
    let out: string[];
    if (resolved) {
      out = has ? toks : [...toks, 'resolved'];
    } else {
      out = toks.filter((t) => t !== 'resolved');
    }
    return `[${out.join(' ')}]`;
  });

  if (nextRaw === node.raw) return { nodes: doc.nodes.slice() };
  const nodes = doc.nodes.slice();
  nodes[idx] = { ...node, raw: nextRaw };
  return { nodes };
}

/**
 * A fresh comment id that collides with no existing comment id in the doc.
 * Scans every parsed comment (inline + standalone) via criticmarkup.comments and
 * returns the first unused `c-N` (1-based).
 */
export function nextCommentId(doc: Doc): string {
  const used = new Set(docComments(doc).map((c) => c.commentId));
  let n = 1;
  while (used.has(`c-${n}`)) n++;
  return `c-${n}`;
}
