// Quick-add capture grammar.
//
// "What you type is what gets stored" — the bar grammar IS the file grammar
// (BRIEF §3). parseInput() turns a free-form capture string into a structured
// CaptureResult; the store then builds a canonical `- [ ] <body>` line from it
// and hands that to @core parse(). We never invent a second representation: the
// fields here map one-to-one onto file tokens.
//
// Grammar:
//   bare text          -> task title
//   #tag  #proj/sub    -> tag        (slash nests)
//   @context           -> context
//   ! !! !!!           -> priority (level = bang count)
//   p1 p2 p3           -> priority aliases (p1 = highest -> !!!)
//   key:value          -> structured token (closed key set validated elsewhere)
//   bare NL date       -> due:<ISO>  (no sigil; chrono extracts it)
//   leading "due "     -> force the next phrase through the date parser -> due:
//   leading "start "   -> ... -> scheduled:
//   //notes            -> description, becomes a `> ` child note
//
// The date is ECHOED IN WORDS in the preview so a locale-ambiguous 3/4 is caught
// before save.

import { parseDate, parseDateStrict, echoWords } from './dates';

/** Reserved keys whose values are dates and must be ISO-normalized on capture
 *  (BRIEF §2: "normalized to ISO on save"). Anything that fails to parse as a
 *  date is kept verbatim (preserved-but-ignored). */
const DATE_KEYS = new Set(['due', 'start', 'scheduled', 'done']);

export interface CaptureField {
  /** What this field will become in the file. */
  kind: 'tag' | 'context' | 'priority' | 'key' | 'date' | 'note' | 'link';
  /** Human-facing summary for the preview line, e.g. "#finance" or "Fri Jul 3". */
  label: string;
  /** The character span in the original input this field came from (for dimming);
   *  null when synthesized (e.g. a date forced by a leading "due "). */
  span: [number, number] | null;
}

export interface CaptureResult {
  /** The plain title (everything not consumed by a token). */
  title: string;
  /** Tags WITHOUT the leading '#'. */
  tags: string[];
  /** Contexts WITHOUT the leading '@'. */
  contexts: string[];
  /** Priority level 0..3 (0 = none). */
  priority: number;
  /** Reserved/structured key tokens, e.g. {due:"2026-07-03"}. */
  keys: Record<string, string>;
  /** Bare http(s) URLs typed/pasted in the title, consumed out of it. The store
   *  serializes each as a `[link](url)` attachment token (BRIEF §3). */
  links: string[];
  /** Optional description -> rendered as a `> ` child note. */
  note: string | null;
  /** Fields, in display order, for the preview line. */
  fields: CaptureField[];
}

const PRIO_ALIAS: Record<string, number> = { p1: 3, p2: 2, p3: 1 };

interface Token {
  text: string;
  start: number;
  end: number;
}

/** Split on whitespace but honor "double quotes" so a quoted value keeps its
 *  spaces as ONE token (`due:"next monday"`). "the bar grammar is the file
 *  grammar" and the file grammar quotes-for-spaces (BRIEF §2). */
function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    const start = i;
    let inQuote = false;
    while (i < n && (inQuote || !/\s/.test(s[i]))) {
      if (s[i] === '"') inQuote = !inQuote;
      i++;
    }
    tokens.push({ text: s.slice(start, i), start, end: i });
  }
  return tokens;
}

/** Parse a quick-add input string into a structured CaptureResult. */
export function parseInput(input: string, ref: Date = new Date()): CaptureResult {
  const result: CaptureResult = {
    title: '',
    tags: [],
    contexts: [],
    priority: 0,
    keys: {},
    links: [],
    note: null,
    fields: [],
  };

  let working = input;

  // 1. //notes — everything after the first `//` is the description. We only
  //    honor `//` as the delimiter when it sits at a word boundary (start of the
  //    string or after whitespace); this stops the `//` inside a URL such as
  //    `https://example.com` from being mistaken for a note split. A note can
  //    then contain anything (including #/@ that should not be re-tokenized).
  const noteMatch = working.match(/(^|\s)\/\//);
  if (noteMatch) {
    const noteIdx = noteMatch.index! + noteMatch[1].length;
    const note = working.slice(noteIdx + 2).trim();
    if (note) {
      result.note = note;
      result.fields.push({ kind: 'note', label: `note: ${note}`, span: [noteIdx, input.length] });
    }
    working = working.slice(0, noteIdx);
  }

  // 2. Leading "due "/"start " override: force ONLY the phrase immediately after
  //    the keyword through the date parser (defeats month-name-as-noun, e.g.
  //    "due april pay rent" -> due:April + title "pay rent"). If the phrase right
  //    after the keyword is not itself a date ("Due diligence review friday"),
  //    the override does nothing and the input is treated as ordinary text — the
  //    normal no-sigil path still catches a trailing "friday".
  const override = working.match(/^(\s*(due|start)\s+)/i);
  if (override) {
    const prefixLen = override[1].length;
    const remainder = working.slice(prefixLen);
    const d = parseDate(remainder, ref);
    if (d && d.index === 0) {
      const key = override[2].toLowerCase() === 'due' ? 'due' : 'scheduled';
      const dateEnd = prefixLen + d.text.length;
      result.keys[key] = d.iso;
      result.fields.push({
        kind: 'date',
        label: `${key}: ${echoWords(d.iso)}`,
        span: [prefixLen, dateEnd],
      });
      // Blank out the keyword + its date span so the REMAINING words flow to the
      // title (and the token loop below still picks up any #tags/@contexts among
      // them). Setting the key also suppresses the bare-NL-date pass.
      working = blankOut(working, [[0, dateEnd]]);
    }
  }

  // 3. Sigil tokens: #tag, @context, !..., p1..p3, key:value. Quote-aware
  //    tokenizer so a quoted key value keeps its spaces; recorded spans let the
  //    bar dim recognized runs.
  const consumed: Array<[number, number]> = [];
  for (const { text: word, start, end } of tokenize(working)) {
    if (word.length > 1 && word.startsWith('#')) {
      result.tags.push(word.slice(1));
      result.fields.push({ kind: 'tag', label: word, span: [start, end] });
      consumed.push([start, end]);
    } else if (word.length > 1 && word.startsWith('@')) {
      result.contexts.push(word.slice(1));
      result.fields.push({ kind: 'context', label: word, span: [start, end] });
      consumed.push([start, end]);
    } else if (/^!{1,3}$/.test(word)) {
      result.priority = word.length;
      result.fields.push({ kind: 'priority', label: '!'.repeat(word.length), span: [start, end] });
      consumed.push([start, end]);
    } else if (PRIO_ALIAS[word.toLowerCase()] !== undefined) {
      const level = PRIO_ALIAS[word.toLowerCase()];
      result.priority = level;
      result.fields.push({ kind: 'priority', label: '!'.repeat(level), span: [start, end] });
      consumed.push([start, end]);
    } else if (/^https?:\/\//i.test(word)) {
      // A bare URL: capture it as a link and CONSUME it out of the title, so the
      // store can emit it as a `[link](url)` attachment token (BRIEF §3).
      result.links.push(word);
      result.fields.push({ kind: 'link', label: word, span: [start, end] });
      consumed.push([start, end]);
    } else {
      const km = word.match(/^([A-Za-z][A-Za-z0-9_]*!?):(.+)$/);
      if (km) {
        const key = km[1];
        // Strip surrounding quotes from the value (quoted-for-spaces).
        let value = km[2].replace(/^"([\s\S]*)"$/, '$1');
        // ISO-normalize date-valued reserved keys; unparseable values stay as-is.
        if (DATE_KEYS.has(key.toLowerCase())) {
          const iso = parseDateStrict(value, ref);
          if (iso) value = iso;
        }
        result.keys[key] = value;
        result.fields.push({ kind: 'key', label: `${key}:${value}`, span: [start, end] });
        consumed.push([start, end]);
      }
    }
  }

  // 4. The leftover text (everything not consumed) is the source for both the
  //    title and a bare natural-language date.
  const leftover = blankOut(working, consumed);

  // 5. Bare NL date (no sigil) — only if no explicit due:/scheduled: key already
  //    set one. chrono extracts it from anywhere in the leftover text.
  if (result.keys.due === undefined && result.keys.scheduled === undefined) {
    const d = parseDate(leftover, ref);
    if (d) {
      result.keys.due = d.iso;
      result.fields.push({
        kind: 'date',
        label: `due: ${echoWords(d.iso)}`,
        span: [d.index, d.index + d.text.length],
      });
      // Remove the matched date phrase from the leftover so it is not also title.
      const before = leftover.slice(0, d.index);
      const after = leftover.slice(d.index + d.text.length);
      result.title = normalize(before + ' ' + after);
      return finalize(result);
    }
  }

  result.title = normalize(leftover);
  return finalize(result);
}

/** Replace consumed spans with spaces so the leftover keeps original offsets. */
function blankOut(s: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return s;
  const chars = s.split('');
  for (const [a, b] of spans) for (let i = a; i < b && i < chars.length; i++) chars[i] = ' ';
  return chars.join('');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function finalize(r: CaptureResult): CaptureResult {
  r.title = normalize(r.title);
  return r;
}

/** A single quiet preview line for the bar, e.g.
 *  "Pay AWS invoice · #finance · !!! · due Fri Jul 3". */
export function previewLine(r: CaptureResult): string {
  const bits: string[] = [];
  if (r.title) bits.push(r.title);
  for (const t of r.tags) bits.push(`#${t}`);
  for (const c of r.contexts) bits.push(`@${c}`);
  if (r.priority) bits.push('!'.repeat(r.priority));
  for (const [k, v] of Object.entries(r.keys)) {
    bits.push(k === 'due' || k === 'scheduled' || k === 'start' ? `${k} ${echoWords(v)}` : `${k}:${v}`);
  }
  for (const l of r.links) bits.push(l);
  if (r.note) bits.push(`note: ${r.note}`);
  return bits.join('  ·  ');
}
