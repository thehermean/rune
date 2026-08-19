// Annotated-doc reconciliation — the safe paste round-trip (Wave 2 / M5, BRIEF §6).
//
// The paste round-trip (the default, provider-agnostic AI path): an LLM re-emits
// the WHOLE doc with CriticMarkup inserted; the user pastes it back; Rune
// reconciles BY ^id, not position, and VALIDATES that every non-annotation byte
// is unchanged before accepting, previewing as a diff. The ID-reconciliation +
// unchanged-bytes guard is MANDATORY — it's what protects weaker models from
// whole-doc corruption.
//
// Two layers of validation, both mandatory:
//   1. STRUCTURAL walk (by ^id, never line number): tasks line up one-for-one in
//      order with matching ids/state/indent; only ADDED critic segments and
//      standalone comment/note lines are permitted. Gives precise, id-named
//      rejection reasons.
//   2. BYTE-LEVEL guard (the real "unchanged bytes" law): reconstruct the
//      original from the annotated text by stripping EXACTLY the accepted
//      annotation insertions (added inline critic segments, added standalone
//      comment/note lines) and require the result to equal the original text
//      BYTE-FOR-BYTE. This catches whitespace-only mutations the structural walk
//      cannot see — a missing space after `]` (`- [x]done`), doubled internal
//      spaces, trailing whitespace — and CRLF line endings, which are rejected
//      explicitly (see the CRLF boundary note below).
//
// CRLF boundary decision: the canonical `.rune` file is LF-only (serialize joins
// with '\n'). A paste that introduces CR (`\r`, i.e. CRLF) where the original is
// LF is REJECTED with a CRLF-specific reason, never silently normalized — we do
// not let `\r` bytes leak into the canonical file. (parse->serialize round-trip,
// by contrast, is byte-lossless and preserves whatever bytes it is given; only
// this merge boundary rejects.)
//
// The guard is deliberately STRICT and conservative: when unsure, reject.

import type { Doc, Node, RawNode, Segment, TaskNode } from './types';
import { parse } from './index';

export interface MergeResult {
  ok: boolean;
  mergedText?: string;
  addedComments?: number;
  rejectedReason?: string;
}

/** A task carries a critic segment iff the model annotated it inline. */
function isCritic(s: Segment): boolean {
  return s.kind === 'critic';
}

function countCritics(t: TaskNode): number {
  return t.segments.filter(isCritic).length;
}

/**
 * Validate the annotated segment stream against the original: the original's
 * FULL ordered segment list (body tokens AND any pre-existing critics) must
 * appear byte-identically, in order, inside the annotated list — and every
 * annotated segment NOT consumed by that match must be a newly-added critic.
 *
 * Returns null if valid, else a precise rejection reason.
 */
function diffSegments(orig: TaskNode, ann: TaskNode): string | null {
  const o = orig.segments;
  const a = ann.segments;
  let k = 0; // pointer into the original segments
  for (const seg of a) {
    if (k < o.length && o[k].raw === seg.raw && o[k].kind === seg.kind) {
      k++; // matched a preserved original segment in order
      continue;
    }
    // Unmatched annotated segment: only a freshly-added critic is permitted.
    if (!isCritic(seg)) {
      return `body changed on ${label(orig)} (unexpected "${seg.raw}")`;
    }
  }
  if (k < o.length) {
    // Some original segment was dropped, mutated, or reordered out of place.
    return isCritic(o[k])
      ? `annotation changed on ${label(orig)}`
      : `body changed on ${label(orig)} ("${o[k].raw}" missing or moved)`;
  }
  return null;
}

/**
 * The critic segment raws present in the annotated task but NOT in the original
 * (matched by exact raw, honoring multiplicity). These are the insertions the
 * byte-level guard is allowed to strip when reconstructing the original line.
 * Precondition: diffSegments(orig, ann) returned null.
 */
function addedCriticsOf(orig: TaskNode, ann: TaskNode): string[] {
  const remaining = new Map<string, number>();
  for (const s of orig.segments) {
    if (isCritic(s)) remaining.set(s.raw, (remaining.get(s.raw) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const s of ann.segments) {
    if (!isCritic(s)) continue;
    const n = remaining.get(s.raw) ?? 0;
    if (n > 0) remaining.set(s.raw, n - 1);
    else added.push(s.raw);
  }
  return added;
}

/** Stable label for an offending task in a reject reason. */
function label(t: TaskNode): string {
  return t.id ? `^${t.id}` : `untitled task "${t.raw.trim()}"`;
}

/**
 * Validate that an annotated task is the original task plus only added critic
 * segments. Returns null if valid, else a precise rejection reason.
 */
function diffTask(orig: TaskNode, ann: TaskNode): string | null {
  if (orig.id !== ann.id) {
    return `id changed on ${label(orig)} (became ${ann.id ? `^${ann.id}` : 'none'})`;
  }
  if (orig.stateChar !== ann.stateChar) {
    return `state changed on ${label(orig)} ([${orig.stateChar}] -> [${ann.stateChar}])`;
  }
  if (orig.indent !== ann.indent) {
    return `indent changed on ${label(orig)} (${orig.indent} -> ${ann.indent} spaces)`;
  }
  // The body and any pre-existing critics must survive intact and in order;
  // only added critic segments are permitted (see diffSegments).
  return diffSegments(orig, ann);
}

/** Standalone lines an annotator is allowed to INSERT between tasks. */
function isAddedAnnotationNode(n: Node): n is RawNode {
  return n.type === 'comment' || n.type === 'note';
}

/** True when two non-task nodes are byte-identical (these must be preserved). */
function sameRawNode(a: RawNode, b: RawNode): boolean {
  return a.type === b.type && a.raw === b.raw;
}

/**
 * Remove each added critic raw from an annotated task line, along with exactly
 * one flanking space (the separator the model inserted), recovering the original
 * line's bytes. A critic segment is always space-delimited in the body (that is
 * how the scanner isolates it), so a leading-space strip is the common case; the
 * trailing/bare fallbacks keep this total. If a raw cannot be located the line is
 * left unchanged and the final byte-compare will reject (safe by construction).
 */
function stripInlineCritics(line: string, criticRaws: string[]): string {
  let out = line;
  for (const c of criticRaws) {
    const lead = ' ' + c;
    let idx = out.indexOf(lead);
    if (idx !== -1) {
      out = out.slice(0, idx) + out.slice(idx + lead.length);
      continue;
    }
    const trail = c + ' ';
    idx = out.indexOf(trail);
    if (idx !== -1) {
      out = out.slice(0, idx) + out.slice(idx + trail.length);
      continue;
    }
    idx = out.indexOf(c);
    if (idx !== -1) out = out.slice(0, idx) + out.slice(idx + c.length);
  }
  return out;
}

/**
 * Reconcile the annotated document against the original BY ^id.
 *
 * Walk both node streams with two pointers. Tasks must line up one-for-one in
 * order with matching ids (per `diffTask`). Between tasks, the annotated stream
 * may insert standalone comment/note lines, but every other non-task line
 * (headings, blanks, html-comments, plain text) must stay present, identical,
 * and in order. On a clean structural pass we then run the byte-level guard.
 */
export function mergeAnnotated(originalText: string, annotatedText: string): MergeResult {
  const orig: Doc = parse(originalText);
  const ann: Doc = parse(annotatedText);

  const origNodes = orig.nodes;
  const annNodes = ann.nodes;
  // Node index == line index (parse splits on '\n', one node per line), so these
  // line arrays let the byte guard strip exactly the accepted insertions.
  const annLines = annotatedText.split('\n');

  let i = 0; // pointer into original nodes
  let j = 0; // pointer into annotated nodes
  let inlineCritics = 0; // critic segments added on existing task lines
  let standaloneAdds = 0; // comment/note lines added between tasks

  // Byte-guard bookkeeping, filled during the structural walk.
  const droppedLines = new Set<number>(); // annotated line indices to remove
  const strippedTaskLines = new Map<number, string[]>(); // line idx -> added critic raws

  while (i < origNodes.length || j < annNodes.length) {
    const o = origNodes[i];
    const a = annNodes[j];

    // Skip newly inserted standalone annotation lines in the annotated stream,
    // but only when they don't correspond to an identical original line at the
    // same position (preserved comment/note lines are matched below).
    if (a && isAddedAnnotationNode(a) && (!o || !(o.type === a.type && o.raw === a.raw))) {
      standaloneAdds++;
      droppedLines.add(j);
      j++;
      continue;
    }

    if (!o) {
      return reject(
        a && a.type === 'task'
          ? `unexpected new task ${label(a)} added by the annotator`
          : `unexpected line added by the annotator: "${a?.raw ?? ''}"`,
      );
    }
    if (!a) {
      return reject(
        o.type === 'task'
          ? `${label(o)} is missing from the pasted document (removed or reordered)`
          : `a line was removed by the annotator: "${o.raw}"`,
      );
    }

    if (o.type === 'task' || a.type === 'task') {
      if (o.type !== 'task') {
        return reject(`unexpected new task ${label(a as TaskNode)} added by the annotator`);
      }
      if (a.type !== 'task') {
        return reject(`${label(o)} is missing from the pasted document (removed or reordered)`);
      }
      const reason = diffTask(o, a);
      if (reason) return reject(reason);
      const added = addedCriticsOf(o, a);
      if (added.length) strippedTaskLines.set(j, added);
      inlineCritics += countCritics(a) - countCritics(o);
      i++;
      j++;
      continue;
    }

    // Both are non-task nodes: they must be byte-identical and in order.
    if (!sameRawNode(o, a)) {
      return reject(`a non-task line changed: "${o.raw}" -> "${a.raw}"`);
    }
    i++;
    j++;
  }

  // --- byte-level guard: reconstruct original from annotated, require equality.
  const reconstructed = annLines
    .map((line, idx) => {
      if (droppedLines.has(idx)) return null; // an added standalone annotation line
      const critics = strippedTaskLines.get(idx);
      return critics ? stripInlineCritics(line, critics) : line;
    })
    .filter((l): l is string => l !== null)
    .join('\n');

  if (reconstructed !== originalText) {
    return reject(byteMismatchReason(originalText, reconstructed));
  }

  return {
    ok: true,
    mergedText: annotatedText,
    addedComments: inlineCritics + standaloneAdds,
  };
}

/**
 * A precise reason for a byte-level mismatch after the structural pass. CRLF is
 * called out explicitly (the common failure mode); otherwise we name the first
 * line whose bytes differ from the original.
 */
function byteMismatchReason(originalText: string, reconstructed: string): string {
  if (reconstructed.includes('\r') && !originalText.includes('\r')) {
    return 'line endings changed to CRLF (\\r) — re-paste with Unix (LF) line endings';
  }
  const oLines = originalText.split('\n');
  const rLines = reconstructed.split('\n');
  const n = Math.max(oLines.length, rLines.length);
  for (let k = 0; k < n; k++) {
    if (oLines[k] !== rLines[k]) {
      return `non-annotation bytes changed at line ${k + 1}: "${rLines[k] ?? ''}" != "${oLines[k] ?? ''}"`;
    }
  }
  return 'non-annotation bytes changed (whitespace or content differs from the original)';
}

function reject(rejectedReason: string): MergeResult {
  return { ok: false, rejectedReason };
}
