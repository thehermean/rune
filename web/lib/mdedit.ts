// Pure Markdown editing transforms for the note toolbar. Each takes the text +
// selection and returns the new text + selection, so the component can setDraft
// then restore the caret. No DOM, no React — unit-testable in plain vitest.

export interface EditState {
  text: string;
  start: number;
  end: number;
}

/** Wrap the selection in `left`/`right` (bold, italic, code, strike). With no
 *  selection, drops the caret between the inserted markers. */
export function wrapInline(s: EditState, left: string, right = left): EditState {
  const sel = s.text.slice(s.start, s.end);
  const nt = s.text.slice(0, s.start) + left + sel + right + s.text.slice(s.end);
  if (sel) return { text: nt, start: s.start + left.length, end: s.end + left.length };
  const c = s.start + left.length;
  return { text: nt, start: c, end: c };
}

function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let to = text.indexOf('\n', end);
  if (to === -1) to = text.length;
  return [from, to];
}

/** Toggle a line prefix over every line the selection touches. `exclusive`
 *  strips a conflicting prefix first (e.g. an existing heading level). */
export function toggleLinePrefix(s: EditState, prefix: string, exclusive?: RegExp): EditState {
  const [from, to] = lineRange(s.text, s.start, s.end);
  const lines = s.text.slice(from, to).split('\n');
  const has = lines.every((l) => l.startsWith(prefix));
  const next = lines
    .map((l) => (has ? l.slice(prefix.length) : prefix + (exclusive ? l.replace(exclusive, '') : l)))
    .join('\n');
  const nt = s.text.slice(0, from) + next + s.text.slice(to);
  return { text: nt, start: from, end: from + next.length };
}

/** Number (1., 2., …) every touched line, or strip numbering if all are numbered. */
export function numberList(s: EditState): EditState {
  const [from, to] = lineRange(s.text, s.start, s.end);
  const lines = s.text.slice(from, to).split('\n');
  const stripped = lines.map((l) => l.replace(/^\s*\d+\.\s+/, ''));
  const allNumbered = lines.every((l) => /^\s*\d+\.\s+/.test(l) || l.trim() === '');
  const next = allNumbered ? stripped.join('\n') : stripped.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const nt = s.text.slice(0, from) + next + s.text.slice(to);
  return { text: nt, start: from, end: from + next.length };
}

/** Insert `[sel|text](url)` and select the url so the user can type over it. */
export function insertLink(s: EditState, url = 'https://'): EditState {
  const sel = s.text.slice(s.start, s.end) || 'text';
  const inserted = `[${sel}](${url})`;
  const nt = s.text.slice(0, s.start) + inserted + s.text.slice(s.end);
  const urlStart = s.start + sel.length + 3; // past "[sel]("
  return { text: nt, start: urlStart, end: urlStart + url.length };
}

/** Replace the selection with `snippet`, caret after it. */
export function insertAt(s: EditState, snippet: string): EditState {
  const nt = s.text.slice(0, s.start) + snippet + s.text.slice(s.end);
  const c = s.start + snippet.length;
  return { text: nt, start: c, end: c };
}

/** Toggle a GFM checkbox on `lineIndex` of `text` (Read-mode tap). */
export function toggleCheckboxLine(text: string, lineIndex: number): string {
  const lines = text.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return text;
  lines[lineIndex] = lines[lineIndex].replace(
    /^(\s*[-*+]\s+\[)([ xX])(\])/,
    (_m, a: string, c: string, b: string) => a + (c.toLowerCase() === 'x' ? ' ' : 'x') + b,
  );
  return lines.join('\n');
}
