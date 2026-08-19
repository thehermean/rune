// Today / Agenda filter — regression tests for two bugs fixed on wave/improvements:
//
//   Bug 1 (timezone): todayItems used `new Date(nowISO)` on a date-only string,
//     which parses as UTC midnight. West of UTC that collapses "today" to
//     yesterday, so everything due today vanished (overdue still showed).
//   Bug 2 (state): the filter used `state !== 'open'`, silently dropping a
//     started `- [/]` (doing) task that was due today.
//
// The fix compares canonical ISO date strings end-to-end (no UTC round-trip of a
// date-only string) and treats open|doing as active (mirroring sequence.ts).
//
// To prove the timezone fix is real, this file is also run under a west-of-UTC
// zone in CI via a separate vitest invocation:  TZ=America/New_York npx vitest run
// Every assertion below must hold in BOTH the machine zone and America/New_York.

import { describe, it, expect } from 'vitest';
import { parse, titleOf } from '../src/index';
import { todayItems } from '../web/lib/today';
import { toISO, isOnOrBeforeISO, isOnOrBefore } from '../web/lib/dates';

function doc(lines: string[]) {
  return parse(lines.join('\n'));
}

const TODAY = '2026-07-02';
// A real Date at 10:00 LOCAL on 2026-07-02 — the value TodayView passes through
// as toISO(now). Constructed via the local-time Date ctor so `toISO` yields the
// local calendar date regardless of the host timezone.
const NOW_LOCAL = new Date(2026, 6, 2, 10, 0, 0);

describe('date helpers — the date-only-string UTC pitfall', () => {
  it('isOnOrBeforeISO compares ISO date strings with no Date round-trip', () => {
    expect(isOnOrBeforeISO('2026-07-02', TODAY)).toBe(true); // due today
    expect(isOnOrBeforeISO('2026-07-01', TODAY)).toBe(true); // overdue
    expect(isOnOrBeforeISO('2026-07-03', TODAY)).toBe(false); // future
  });

  it('accepts a full ISO datetime as `nowDate` (uses its leading date)', () => {
    expect(isOnOrBeforeISO('2026-07-02', '2026-07-02T10:00:00')).toBe(true);
  });

  it('rejects non-date values instead of treating them as overdue', () => {
    expect(isOnOrBeforeISO('someday', TODAY)).toBe(false);
    expect(isOnOrBeforeISO('', TODAY)).toBe(false);
  });

  it('isOnOrBefore(Date) stays consistent with the string variant', () => {
    // Whatever the host zone, toISO(NOW_LOCAL) is the local date of "now", and a
    // task due that same local date is on-or-before it. Before the fix this path
    // could disagree with itself west of UTC.
    expect(isOnOrBefore('2026-07-02', NOW_LOCAL)).toBe(true);
    expect(isOnOrBefore('2026-07-03', NOW_LOCAL)).toBe(false);
  });
});

describe('todayItems — timezone-safe due-today (Bug 1)', () => {
  it('shows a task due today when called exactly as TodayView does', () => {
    // TodayView computes todayItems(doc, toISO(now)). Simulate that end-to-end.
    const d = doc(['- [ ] Ship it due:2026-07-02 ^t-1']);
    const items = todayItems(d, toISO(NOW_LOCAL));
    expect(items.map((t) => t.id)).toEqual(['t-1']);
  });

  it('shows a task due today for a plain YYYY-MM-DD "now"', () => {
    const d = doc(['- [ ] Ship it due:2026-07-02 ^t-1']);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-1']);
  });

  it('uses scheduled: when there is no due:', () => {
    const d = doc(['- [ ] Soft task scheduled:2026-07-02 ^t-1']);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-1']);
  });

  it('due: wins over scheduled: for the relevant date', () => {
    // due today, scheduled far future -> still on the agenda today.
    const d = doc(['- [ ] Both due:2026-07-02 scheduled:2026-12-01 ^t-1']);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-1']);
  });

  it('excludes a task due strictly in the future', () => {
    const d = doc(['- [ ] Later due:2026-07-03 ^t-1']);
    expect(todayItems(d, TODAY)).toEqual([]);
  });

  it('excludes a task with neither due: nor scheduled:', () => {
    const d = doc(['- [ ] Floating ^t-1']);
    expect(todayItems(d, TODAY)).toEqual([]);
  });
});

describe('todayItems — state inclusion (Bug 2)', () => {
  it('includes a started (doing / [/]) task due today', () => {
    const d = doc(['- [/] In progress due:2026-07-02 ^t-1']);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-1']);
  });

  it('includes an overdue doing task', () => {
    const d = doc(['- [/] Late & started due:2026-06-30 ^t-1']);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-1']);
  });

  it('includes overdue open tasks', () => {
    const d = doc(['- [ ] Overdue due:2026-06-15 ^t-1']);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-1']);
  });

  it('excludes done, cancelled, and deferred tasks even if dated today', () => {
    const d = doc([
      '- [x] Done due:2026-07-02 ^t-1',
      '- [-] Cancelled due:2026-07-02 ^t-2',
      '- [>] Deferred due:2026-07-02 ^t-3',
    ]);
    expect(todayItems(d, TODAY)).toEqual([]);
  });

  it('keeps only open|doing from a mixed doc', () => {
    const d = doc([
      '- [ ] Open due:2026-07-02 ^t-open',
      '- [/] Doing due:2026-07-02 ^t-doing',
      '- [x] Done due:2026-07-02 ^t-done',
      '- [-] Cancelled due:2026-07-02 ^t-cancelled',
      '- [>] Deferred due:2026-07-02 ^t-deferred',
    ]);
    expect(new Set(todayItems(d, TODAY).map((t) => t.id))).toEqual(
      new Set(['t-open', 't-doing']),
    );
  });
});

describe('todayItems — sort order (priority desc, then date asc)', () => {
  it('sorts by priority descending', () => {
    const d = doc([
      '- [ ] low due:2026-07-02 ^t-low',
      '- [ ] high !!! due:2026-07-02 ^t-high',
      '- [ ] mid ! due:2026-07-02 ^t-mid',
    ]);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-high', 't-mid', 't-low']);
  });

  it('within equal priority, sorts by relevant date ascending (overdue first)', () => {
    const d = doc([
      '- [ ] today due:2026-07-02 ^t-today',
      '- [ ] old due:2026-06-01 ^t-old',
      '- [ ] mid due:2026-06-20 ^t-mid',
    ]);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-old', 't-mid', 't-today']);
  });

  it('priority dominates date (a high-priority today beats an overdue low)', () => {
    const d = doc([
      '- [ ] urgent !! due:2026-07-02 ^t-urgent',
      '- [ ] stale due:2026-05-01 ^t-stale',
    ]);
    expect(todayItems(d, TODAY).map((t) => t.id)).toEqual(['t-urgent', 't-stale']);
  });

  it('sanity: titles resolve for the picked tasks', () => {
    const d = doc(['- [ ] Buy milk due:2026-07-02 ^t-1']);
    const items = todayItems(d, TODAY);
    expect(items.map((t) => titleOf(t))).toEqual(['Buy milk']);
  });
});
