import type { Doc, Node, TaskNode } from './types';
import { classifyLine } from './parse';

/** Canonical rebuild of a task line from its structured fields. */
function canonicalTask(t: TaskNode): string {
  const prefix = ' '.repeat(t.indent) + '- [' + t.stateChar + ']';
  const parts: string[] = [];
  const body = t.segments.map((s) => s.raw).join(' ');
  if (body) parts.push(body);
  if (t.id) parts.push('^' + t.id);
  const rest = parts.join(' ');
  return rest ? prefix + ' ' + rest : prefix;
}

/**
 * `raw` is a FAITHFUL spelling of the node iff re-parsing it yields the same
 * indent, state, id, and segment stream. Pristine parsed nodes are always
 * faithful, so their exact bytes (tabs, doubled/trailing spaces, a missing space
 * after `]`, a `\r` from a CRLF file) survive `serialize(parse(x)) === x`. The
 * moment the app STRUCTURALLY edits the node — a state toggle, reindent, or any
 * body/segment change (all of which leave `raw` stale) — the check fails and we
 * emit the canonical form instead, so real edits are always written canonically.
 * This makes the round-trip byte-lossless for legal-but-non-canonical lines
 * without ever persisting a stale hand-edit, and needs no extra node field
 * (so the parsed-node shape the whole web layer consumes stays unchanged).
 */
function rawIsFaithful(t: TaskNode): boolean {
  if (typeof t.raw !== 'string') return false;
  const reparsed = classifyLine(t.raw);
  if (reparsed.type !== 'task') return false;
  if (reparsed.indent !== t.indent) return false;
  if (reparsed.stateChar !== t.stateChar) return false;
  if ((reparsed.id ?? null) !== (t.id ?? null)) return false;
  if (reparsed.segments.length !== t.segments.length) return false;
  for (let i = 0; i < t.segments.length; i++) {
    if (reparsed.segments[i].raw !== t.segments[i].raw) return false;
  }
  return true;
}

function serializeTask(t: TaskNode): string {
  return rawIsFaithful(t) ? t.raw : canonicalTask(t);
}

export function serializeNode(node: Node): string {
  return node.type === 'task' ? serializeTask(node) : node.raw;
}

export function serialize(doc: Doc): string {
  return doc.nodes.map(serializeNode).join('\n');
}
