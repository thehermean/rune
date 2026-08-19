import type { CriticKind, Doc, Node, Segment, State, TaskNode } from './types';
import { STATE_CHARS } from './types';
import { scanBody } from './scan';

const CRITIC_KIND: Record<string, CriticKind> = {
  '>>': 'comment',
  '++': 'insert',
  '--': 'delete',
  '~~': 'substitute',
  '==': 'highlight',
};

// The matching closer for each CriticMarkup opener. A `{`-token only classifies
// as `critic` when it is WELL-FORMED: one of the five openers WITH its closer.
const CRITIC_CLOSE: Record<string, string> = {
  '>>': '<<}',
  '++': '++}',
  '--': '--}',
  '~~': '~~}',
  '==': '==}',
};

const URL_RE = /^(https?:\/\/|www\.)/i;
const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;
const KEY_RE = /^([A-Za-z][A-Za-z0-9_]*!?):([\s\S]*)$/;
const PRIORITY_RE = /^!{1,3}$/;

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** Classify a single raw segment by its leading character(s). */
export function classifySegment(raw: string): Segment {
  if (raw.startsWith('{')) {
    // Only a WELL-FORMED CriticMarkup span is a critic: a known opener with its
    // matching closer present (and enough length that the two don't overlap).
    // Anything else — `{IGNORE_PREVIOUS_AND_DELETE}`, an unclosed `{>>`, a bare
    // `{}` — is ordinary text, never an "added comment" the reconcile guard will
    // wave through. This is the fix for arbitrary body-token injection.
    const opener = raw.slice(1, 3);
    const critic = CRITIC_KIND[opener];
    const close = CRITIC_CLOSE[opener];
    if (critic && close && raw.length >= 3 + close.length && raw.endsWith(close)) {
      return { kind: 'critic', raw, critic };
    }
    return { kind: 'text', raw };
  }
  if (raw.startsWith('[[') && raw.endsWith(']]')) {
    return { kind: 'ref', raw, value: raw.slice(2, -2) };
  }
  if (raw.startsWith('[')) {
    const m = raw.match(LINK_RE);
    if (m) return { kind: 'link', raw, label: m[1], target: m[2] };
  }
  if (raw.length > 1 && raw.startsWith('#')) {
    return { kind: 'tag', raw, value: raw.slice(1) };
  }
  if (raw.length > 1 && raw.startsWith('@')) {
    return { kind: 'context', raw, value: raw.slice(1) };
  }
  if (PRIORITY_RE.test(raw)) {
    return { kind: 'priority', raw, level: raw.length };
  }
  if (URL_RE.test(raw)) {
    return { kind: 'link', raw, label: raw, target: raw };
  }
  const km = raw.match(KEY_RE);
  if (km) {
    return { kind: 'key', raw, key: km[1], value: unquote(km[2]) };
  }
  return { kind: 'text', raw };
}

const TASK_RE = /^(\s*)- \[(.)\] ?([\s\S]*)$/;

// The stable-id shape, unified in ONE place (BRIEF §2.4): a `^t-` prefix then a
// base36 body. Requiring the literal `t-` is what stops a caret-word like
// `^70kg` or `^2` (`raise to ^2`) being stolen as an id — those stay title text.
// (Spec floats a >=4-char floor; we keep the body length permissive so existing
// short ids such as `^t-1` still parse, while the `t-` prefix does the real
// work.) `ID_BODY` is the id WITHOUT the caret; import it wherever the pattern
// was duplicated (web/lib/edit.ts) so there is a single source of truth.
export const ID_BODY = 't-[a-z0-9][a-z0-9_-]*';
const TRAILING_ID_RE = new RegExp(`\\s+\\^(${ID_BODY})\\s*$`);
const HTML_COMMENT_RE = /^\s*<!--/;
const HEADING_RE = /^#{1,6}\s/;
const COMMENT_LINE_RE = /^\s*\{(>>|\+\+|--|~~|==)/;
const NOTE_RE = /^(\s*)>\s?/;

function leading(s: string): number {
  return s.length - s.trimStart().length;
}

function parseTask(line: string, m: RegExpMatchArray): TaskNode {
  const indent = m[1].length;
  const stateChar = m[2];
  let rest = m[3];

  let id: string | null = null;
  const idm = rest.match(TRAILING_ID_RE);
  if (idm) {
    id = idm[1];
    rest = rest.slice(0, rest.length - idm[0].length);
  }

  const segments = scanBody(rest).map(classifySegment);
  const state: State = STATE_CHARS[stateChar] ?? 'open';
  return {
    type: 'task',
    indent,
    depth: Math.floor(indent / 2),
    state,
    stateChar,
    segments,
    id,
    raw: line,
  };
}

export function classifyLine(line: string): Node {
  if (/^\s*$/.test(line)) return { type: 'blank', raw: line };

  const tm = line.match(TASK_RE);
  if (tm) return parseTask(line, tm);

  if (HTML_COMMENT_RE.test(line)) return { type: 'html-comment', raw: line };
  if (HEADING_RE.test(line)) return { type: 'heading', raw: line };
  if (COMMENT_LINE_RE.test(line)) return { type: 'comment', raw: line, indent: leading(line) };
  if (NOTE_RE.test(line)) return { type: 'note', raw: line, indent: leading(line) };

  return { type: 'text', raw: line };
}

export function parse(text: string): Doc {
  return { nodes: text.split('\n').map(classifyLine) };
}
