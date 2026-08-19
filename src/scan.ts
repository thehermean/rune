// Segment scanner: splits a task-line body into ordered raw segments.
//
// Most segments are single space-delimited words, but bracketed and quoted
// spans (links, refs, CriticMarkup, quoted key values) are kept intact even
// when they contain spaces. Keeping segment order and treating these spans as
// atomic is exactly what lets serialize() rebuild a line by joining segments
// with single spaces.

const CRITIC_CLOSE: Record<string, string> = {
  '>>': '<<}',
  '++': '++}',
  '--': '--}',
  '~~': '~~}',
  '==': '==}',
};

/** If a CriticMarkup span opens at `i`, return the index just past its close. */
function criticEnd(body: string, i: number): number {
  const close = CRITIC_CLOSE[body.slice(i + 1, i + 3)];
  if (!close) return -1;
  const end = body.indexOf(close, i + 3);
  return end === -1 ? -1 : end + close.length;
}

/** If a `[label](target)` link opens at `i`, return the index just past `)`. */
function linkEnd(body: string, i: number): number {
  const rb = body.indexOf(']', i + 1);
  if (rb === -1 || body[rb + 1] !== '(') return -1;
  const rp = body.indexOf(')', rb + 2);
  return rp === -1 ? -1 : rp + 1;
}

export function scanBody(body: string): string[] {
  const segs: string[] = [];
  const n = body.length;
  let i = 0;

  while (i < n) {
    while (i < n && body[i] === ' ') i++;
    if (i >= n) break;
    const start = i;
    const c = body[i];

    if (c === '{') {
      const end = criticEnd(body, i);
      if (end !== -1) {
        segs.push(body.slice(start, end));
        i = end;
        continue;
      }
    }

    if (c === '[') {
      if (body[i + 1] === '[') {
        const end = body.indexOf(']]', i + 2);
        if (end !== -1) {
          i = end + 2;
          segs.push(body.slice(start, i));
          continue;
        }
      } else {
        const end = linkEnd(body, i);
        if (end !== -1) {
          segs.push(body.slice(start, end));
          i = end;
          continue;
        }
      }
    }

    // Default word: read to the next space, jumping over any "quoted" run so a
    // key value like recur!:"every month on the last" stays a single segment.
    let j = i;
    while (j < n && body[j] !== ' ') {
      if (body[j] === '"') {
        const q = body.indexOf('"', j + 1);
        if (q !== -1) {
          j = q + 1;
          continue;
        }
      }
      j++;
    }
    segs.push(body.slice(start, j));
    i = j;
  }

  return segs;
}
