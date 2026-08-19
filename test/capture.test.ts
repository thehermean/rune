import { describe, it, expect } from 'vitest';
import { parseInput } from '../web/lib/capture';

// Pinned reference date for deterministic chrono output.
//   2026-06-30 is a Tuesday.
//   2026-07-01 is a Wednesday (tomorrow).
//   2026-07-03 is a Friday.
//   2026-07-06 is the next Monday.
// (Same reference calendar the recurrence tests use.)
const REF = new Date(2026, 5, 30, 12, 0, 0);

describe('capture: leading due/start override no longer discards the title', () => {
  it('"Due diligence review friday" keeps the title, date via the normal path', () => {
    // Regression: the old override matched any first word "due"/"start" and, if a
    // date appeared ANYWHERE in the remainder, returned title:''. "diligence" is
    // not a date, so the override must NOT fire; the trailing "friday" is caught
    // by the ordinary no-sigil date pass.
    const r = parseInput('Due diligence review friday', REF);
    expect(r.title).toBe('Due diligence review');
    expect(r.keys.due).toBe('2026-07-03');
  });

  it('"due april pay rent" keeps "pay rent" and forces april through the parser', () => {
    const r = parseInput('due april pay rent', REF);
    expect(r.title).toBe('pay rent');
    // forwardDate pushes a bare "april" to the next April (some year).
    expect(r.keys.due).toMatch(/^\d{4}-04-\d{2}$/);
  });

  it('pure "due friday" sets the date with an empty title', () => {
    const r = parseInput('due friday', REF);
    expect(r.keys.due).toBe('2026-07-03');
    expect(r.title).toBe('');
  });

  it('override still tokenizes #tags/@contexts among the remaining words', () => {
    const r = parseInput('due tomorrow buy milk #errands', REF);
    expect(r.keys.due).toBe('2026-07-01');
    expect(r.title).toBe('buy milk');
    expect(r.tags).toEqual(['errands']);
  });

  it('leading "start" maps to scheduled: when the next phrase is a date', () => {
    const r = parseInput('start monday prep slides', REF);
    expect(r.keys.scheduled).toBe('2026-07-06');
    expect(r.keys.due).toBeUndefined();
    expect(r.title).toBe('prep slides');
  });
});

describe('capture: // only splits real notes, never URLs', () => {
  it('a bare URL is captured as a link and consumed out of the title (not a note)', () => {
    const r = parseInput('Read https://example.com/docs', REF);
    expect(r.title).toBe('Read');
    expect(r.links).toEqual(['https://example.com/docs']);
    expect(r.note).toBeNull();
    expect(r.keys.due).toBeUndefined();
  });

  it('a URL alongside a tag and a date: URL -> link, other tokens still parse', () => {
    const r = parseInput('Fix https://example.com/a #bug friday', REF);
    expect(r.title).toBe('Fix');
    expect(r.links).toEqual(['https://example.com/a']);
    expect(r.tags).toEqual(['bug']);
    expect(r.keys.due).toBe('2026-07-03');
  });

  it('a real //note is still split off into the description', () => {
    const r = parseInput('Call mum //bring cash', REF);
    expect(r.title).toBe('Call mum');
    expect(r.note).toBe('bring cash');
  });

  it('a //note can contain #/@ without them re-tokenizing', () => {
    const r = parseInput('Plan trip //ask @alice about #budget', REF);
    expect(r.title).toBe('Plan trip');
    expect(r.note).toBe('ask @alice about #budget');
    expect(r.tags).toEqual([]);
    expect(r.contexts).toEqual([]);
  });
});

describe('capture: bare URLs become link tokens', () => {
  it('a bare URL with no other words yields an empty title but a link', () => {
    const r = parseInput('https://example.com', REF);
    expect(r.title).toBe('');
    expect(r.links).toEqual(['https://example.com']);
  });

  it('multiple URLs are all captured, in order', () => {
    const r = parseInput('Refs http://a.test https://b.test/x', REF);
    expect(r.title).toBe('Refs');
    expect(r.links).toEqual(['http://a.test', 'https://b.test/x']);
  });

  it('a URL with a #fragment is one token — the # is not a tag', () => {
    const r = parseInput('Open https://example.com/a#section', REF);
    expect(r.links).toEqual(['https://example.com/a#section']);
    expect(r.tags).toEqual([]);
    expect(r.title).toBe('Open');
  });

  it('a URL inside a //note is NOT re-tokenized as a link', () => {
    const r = parseInput('Call //see https://example.com', REF);
    expect(r.title).toBe('Call');
    expect(r.note).toBe('see https://example.com');
    expect(r.links).toEqual([]);
  });
});

describe('capture: quoted key values', () => {
  it('due:"next monday" is one token and normalizes to ISO', () => {
    const r = parseInput('Meeting due:"next monday"', REF);
    expect(r.keys.due).toBe('2026-07-06');
    expect(r.title).toBe('Meeting');
  });

  it('a quoted non-date value keeps its spaces verbatim', () => {
    const r = parseInput('x recur:"every other monday"', REF);
    expect(r.keys.recur).toBe('every other monday');
    expect(r.title).toBe('x');
  });
});

describe('capture: explicit key dates are ISO-normalized', () => {
  it('due:friday -> ISO', () => {
    expect(parseInput('Pay rent due:friday', REF).keys.due).toBe('2026-07-03');
  });

  it('due:tomorrow -> ISO', () => {
    expect(parseInput('task due:tomorrow', REF).keys.due).toBe('2026-07-01');
  });

  it('scheduled: and done: are normalized too; ISO input is idempotent', () => {
    expect(parseInput('x scheduled:monday', REF).keys.scheduled).toBe('2026-07-06');
    expect(parseInput('x done:2026-06-30', REF).keys.done).toBe('2026-06-30');
  });

  it('an unparseable date value stays verbatim', () => {
    expect(parseInput('x due:someday', REF).keys.due).toBe('someday');
  });

  it('a non-reserved key is preserved untouched (never date-parsed)', () => {
    expect(parseInput('deploy ticket:ABC-123', REF).keys.ticket).toBe('ABC-123');
  });
});

describe('capture: priority aliases (unchanged)', () => {
  it('p1/p2/p3 map to levels 3/2/1', () => {
    expect(parseInput('task p1', REF).priority).toBe(3);
    expect(parseInput('task p2', REF).priority).toBe(2);
    expect(parseInput('task p3', REF).priority).toBe(1);
  });

  it('!-count still sets priority', () => {
    expect(parseInput('task !!', REF).priority).toBe(2);
    expect(parseInput('task !!!', REF).priority).toBe(3);
  });
});

describe('capture: tags, contexts, and bare NL dates (preserved behavior)', () => {
  it('nested tags and contexts are extracted, title is the leftover', () => {
    const r = parseInput('Ship parser #rune/release @desk', REF);
    expect(r.tags).toEqual(['rune/release']);
    expect(r.contexts).toEqual(['desk']);
    expect(r.title).toBe('Ship parser');
  });

  it('a plain natural-language date (no sigil) becomes due: and is stripped from the title', () => {
    const r = parseInput('Submit report friday', REF);
    expect(r.keys.due).toBe('2026-07-03');
    expect(r.title).toBe('Submit report');
  });
});
