// Today / Agenda — a DERIVED FILTER, not a place items live (BRIEF §5).
//
// Open tasks whose due: or scheduled: is on or before `nowISO` (overdue
// included), sorted by priority desc then date asc. No duplicate state: this
// reads straight off the parsed Doc via @core helpers.

import type { Doc, TaskNode } from '@core';
import { tasks, getKey, priorityOf } from '@core';
import { isOnOrBeforeISO } from './dates';

/**
 * The Today list for `nowISO` (a `YYYY-MM-DD` local date, or any ISO datetime
 * whose leading `YYYY-MM-DD` is the local date). Includes overdue. Sorted
 * priority desc, then the relevant date asc.
 *
 * The comparison is done entirely over ISO date strings — we never do
 * `new Date(nowISO)` on a date-only string, which parses as UTC midnight and,
 * west of UTC, collapses "today" to yesterday (hiding everything due today).
 */
export function todayItems(doc: Doc, nowISO: string): TaskNode[] {
  const nowDate = nowISO.slice(0, 10); // local YYYY-MM-DD, no UTC round-trip

  const picked = tasks(doc).filter((t) => {
    // Active on the agenda = open | doing (mirror sequence.ts's isActive); a
    // started task (`- [/]`) due today must NOT vanish. done | cancelled |
    // deferred are excluded.
    if (t.state !== 'open' && t.state !== 'doing') return false;
    const d = relevantDate(t);
    return d !== null && isOnOrBeforeISO(d, nowDate);
  });

  return picked.sort((a, b) => {
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pa !== pb) return pb - pa; // priority desc
    const da = relevantDate(a) ?? '';
    const db = relevantDate(b) ?? '';
    return da < db ? -1 : da > db ? 1 : 0; // date asc
  });
}

/** The date that puts a task on the agenda: a hard due: wins over a soft
 *  scheduled:. Returns the ISO date string, or null if neither is set. */
export function relevantDate(t: TaskNode): string | null {
  return getKey(t, 'due') ?? getKey(t, 'scheduled') ?? null;
}
