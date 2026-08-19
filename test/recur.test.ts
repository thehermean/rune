import { describe, it, expect } from 'vitest';
import { nextOccurrence, expand } from '../src/recur';

// FIXED anchor dates only — Date.now is unavailable in this runner, and the
// recurrence engine is pure (it computes forward from whatever fromISO it gets).
// Reference calendar (2026):
//   2026-06-30 is a Tuesday.
//   2026-07-03 is a Friday.

describe('nextOccurrence — strictly after the anchor', () => {
  it('daily advances by one day', () => {
    expect(nextOccurrence('every day', '2026-06-30')).toBe('2026-07-01');
    expect(nextOccurrence('daily', '2026-06-30')).toBe('2026-07-01');
  });

  it('every 3 days steps by the interval from the anchor', () => {
    expect(nextOccurrence('every 3 days', '2026-06-30')).toBe('2026-07-03');
  });

  it('weekly-on-weekday lands on the next matching weekday', () => {
    // From Tue 06-30, the next Monday is 07-06.
    expect(nextOccurrence('every monday', '2026-06-30')).toBe('2026-07-06');
  });

  it('every other monday uses interval 2 anchored at the start week', () => {
    // From Tue 06-30, "every other monday" skips 07-06 and lands on 07-13.
    expect(nextOccurrence('every other monday', '2026-06-30')).toBe('2026-07-13');
  });

  it('monthly anchors to the day-of-month of the anchor', () => {
    expect(nextOccurrence('monthly', '2026-06-15')).toBe('2026-07-15');
    // Month-end anchor: Feb has no 31, so it CLAMPS to Feb 28 rather than
    // skipping the month entirely.
    expect(nextOccurrence('every month', '2026-01-31')).toBe('2026-02-28');
  });

  it('every month on the last gives the true last day each month', () => {
    expect(nextOccurrence('every month on the last', '2026-01-15')).toBe('2026-01-31');
    // Month-end edge: from Jan 31, the next "last" is Feb 28 (2026 is not a leap year).
    expect(nextOccurrence('every month on the last', '2026-01-31')).toBe('2026-02-28');
    // April has 30 days.
    expect(nextOccurrence('every month on the last', '2026-03-31')).toBe('2026-04-30');
  });

  it('every weekday skips weekends (Mon–Fri only)', () => {
    // Fri 07-03 -> next weekday is Mon 07-06.
    expect(nextOccurrence('every weekday', '2026-07-03')).toBe('2026-07-06');
    // Mon 07-06 -> Tue 07-07.
    expect(nextOccurrence('every weekday', '2026-07-06')).toBe('2026-07-07');
  });

  it('yearly anchors to the same month/day; explicit "march 1" works', () => {
    expect(nextOccurrence('every year', '2026-03-01')).toBe('2027-03-01');
    expect(nextOccurrence('every year on march 1', '2026-06-30')).toBe('2027-03-01');
    // Before the date this year -> still this year.
    expect(nextOccurrence('every year on march 1', '2026-01-10')).toBe('2026-03-01');
  });
});

describe('expand — the next N occurrences, all strictly after the anchor', () => {
  it('daily', () => {
    expect(expand('every day', '2026-06-30', 3)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  it('every 3 days', () => {
    expect(expand('every 3 days', '2026-06-30', 3)).toEqual([
      '2026-07-03',
      '2026-07-06',
      '2026-07-09',
    ]);
  });

  it('weekly on a weekday', () => {
    expect(expand('every monday', '2026-06-30', 3)).toEqual([
      '2026-07-06',
      '2026-07-13',
      '2026-07-20',
    ]);
  });

  it('every other monday', () => {
    expect(expand('every other monday', '2026-06-30', 3)).toEqual([
      '2026-07-13',
      '2026-07-27',
      '2026-08-10',
    ]);
  });

  it('monthly anchored to the day-of-month', () => {
    expect(expand('monthly', '2026-06-15', 3)).toEqual(['2026-07-15', '2026-08-15', '2026-09-15']);
  });

  it('monthly from a month-end anchor CLAMPS short months instead of skipping', () => {
    // From Jan 31: Feb (28) clamps, Mar (31) full, Apr (30) clamps, May (31)
    // full. No month is silently dropped.
    expect(expand('every month', '2026-01-31', 4)).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
    // From Jan 30: Feb clamps to 28, Mar/Apr keep day 30.
    expect(expand('every month', '2026-01-30', 3)).toEqual([
      '2026-02-28',
      '2026-03-30',
      '2026-04-30',
    ]);
  });

  it('every other month from a month-end anchor clamps on its interval-2 cadence', () => {
    // From Jan 31, interval 2: Mar 31, May 31, Jul 31, Sep clamps to 30, Nov 30.
    expect(expand('every other month', '2026-01-31', 5)).toEqual([
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-09-30',
      '2026-11-30',
    ]);
  });

  it('every month on the last, across a month-end edge', () => {
    expect(expand('every month on the last', '2026-01-31', 4)).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('every weekday skips the weekend', () => {
    // From Fri 07-03: Mon, Tue, Wed (skips Sat 07-04 / Sun 07-05).
    expect(expand('every weekday', '2026-07-03', 3)).toEqual([
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
    ]);
  });

  it('yearly', () => {
    expect(expand('every year on march 1', '2026-06-30', 3)).toEqual([
      '2027-03-01',
      '2028-03-01',
      '2029-03-01',
    ]);
  });

  it('defaults to 10 occurrences', () => {
    expect(expand('every day', '2026-06-30')).toHaveLength(10);
  });
});

describe('garbage and edge inputs', () => {
  it('unknown / unparseable rules -> null / []', () => {
    expect(nextOccurrence('banana', '2026-06-30')).toBeNull();
    expect(nextOccurrence('every blue moon', '2026-06-30')).toBeNull();
    expect(nextOccurrence('', '2026-06-30')).toBeNull();
    expect(expand('banana', '2026-06-30')).toEqual([]);
    expect(expand('', '2026-06-30')).toEqual([]);
  });

  it('malformed anchor date -> null / []', () => {
    expect(nextOccurrence('every day', 'not-a-date')).toBeNull();
    expect(nextOccurrence('every day', '2026-13-40')).toBeNull();
    expect(nextOccurrence('every day', '2026-02-31')).toBeNull(); // impossible date
    expect(expand('every day', 'not-a-date')).toEqual([]);
  });

  it('count <= 0 -> empty array', () => {
    expect(expand('every day', '2026-06-30', 0)).toEqual([]);
    expect(expand('every day', '2026-06-30', -5)).toEqual([]);
  });

  it('mixed weekday lists and "every other <unit>" parse', () => {
    // "every tue,thu" from Tue 06-30 -> next is Thu 07-02.
    expect(nextOccurrence('every tue,thu', '2026-06-30')).toBe('2026-07-02');
    // "every other week" -> interval 2 weeks from the anchor.
    expect(nextOccurrence('every other week', '2026-06-30')).toBe('2026-07-14');
  });

  it('space-separated weekday lists parse ("every mon wed")', () => {
    // Docstring promised space splitting; the split used to be `[,/]`/`and` only.
    // From Tue 06-30: next Mon/Wed is Wed 07-01.
    expect(nextOccurrence('every mon wed', '2026-06-30')).toBe('2026-07-01');
    expect(expand('every mon wed', '2026-06-30', 4)).toEqual([
      '2026-07-01',
      '2026-07-06',
      '2026-07-08',
      '2026-07-13',
    ]);
  });
});

describe('month-end recurrence — re-anchoring retention (Todoist parity)', () => {
  it('every month RE-ANCHORED from each produced date RETAINS month-end from Jan 31', () => {
    // The store recomputes `every month` from each occurrence it writes back.
    // Chaining nextOccurrence must NOT decay to the 28th — it returns to the true
    // last day (Jan31 -> Feb28 -> Mar31 -> Apr30 -> May31 -> Jun30 -> Jul31).
    let d = '2026-01-31';
    const chain: string[] = [];
    for (let i = 0; i < 6; i++) {
      d = nextOccurrence('every month', d)!;
      chain.push(d);
    }
    expect(chain).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
    ]);
  });

  it('a genuine mid-month day is NOT dragged to month-end when re-anchored', () => {
    // Re-anchoring the 15th stays the 15th (no month-end promotion).
    let d = '2026-01-15';
    const chain: string[] = [];
    for (let i = 0; i < 3; i++) {
      d = nextOccurrence('every month', d)!;
      chain.push(d);
    }
    expect(chain).toEqual(['2026-02-15', '2026-03-15', '2026-04-15']);
  });

  it('every month on the 31st CLAMPS short months instead of skipping them', () => {
    // Previously skipped Feb/Apr/Jun/Sep/Nov entirely (Jan31 -> Mar31). Now every
    // month appears, short ones clamped to their last day.
    expect(expand('every month on the 31st', '2026-01-01', 6)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
  });

  it('every month on the 30th clamps only February', () => {
    expect(expand('every month on the 30th', '2026-01-01', 4)).toEqual([
      '2026-01-30',
      '2026-02-28',
      '2026-03-30',
      '2026-04-30',
    ]);
  });
});
