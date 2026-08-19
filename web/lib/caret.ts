// getCaretCoordinates — pixel position of the caret inside a <textarea>, via a
// hidden mirror div that copies the textarea's text-affecting styles (the
// well-known textarea-caret-position technique). Used to anchor the
// [[wiki-link]] autocomplete popup at the caret. Coords are relative to the
// textarea's own content box (add its offsetTop/Left to place within a parent).

const PROPS = [
  'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
  'fontFamily', 'lineHeight', 'textAlign', 'textTransform', 'letterSpacing',
  'wordSpacing', 'tabSize', 'whiteSpace',
];

export function getCaretCoordinates(
  el: HTMLTextAreaElement,
  position: number,
): { top: number; left: number; height: number } {
  const div = document.createElement('div');
  const computed = window.getComputedStyle(el);
  const style = div.style as unknown as Record<string, string>;
  style.position = 'absolute';
  style.visibility = 'hidden';
  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  for (const p of PROPS) style[p] = (computed as unknown as Record<string, string>)[p];

  div.textContent = el.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = el.value.slice(position) || '.';
  div.appendChild(span);
  document.body.appendChild(div);

  const borderTop = parseInt(computed.borderTopWidth || '0', 10) || 0;
  const borderLeft = parseInt(computed.borderLeftWidth || '0', 10) || 0;
  const height = parseInt(computed.lineHeight || '', 10) || parseInt(computed.fontSize || '16', 10) || 16;
  const top = span.offsetTop + borderTop - el.scrollTop;
  const left = span.offsetLeft + borderLeft - el.scrollLeft;
  document.body.removeChild(div);
  return { top, left, height };
}

/** If the caret sits inside an unclosed `[[…`, return where it starts + the
 *  partial query; else null. No `]]` or newline may fall between. */
export function findOpenWikiLink(value: string, caret: number): { bracketStart: number; query: string } | null {
  const upto = value.slice(0, caret);
  const open = upto.lastIndexOf('[[');
  if (open === -1) return null;
  const between = upto.slice(open + 2);
  if (between.includes(']]') || between.includes('\n')) return null;
  return { bracketStart: open, query: between };
}
