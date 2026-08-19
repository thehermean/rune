// Recurrence — the every…->RRULE grammar (Wave 2 / M3, BRIEF §2/§8).
//
// Recurrence keeps Todoist's English grammar VERBATIM in the `.rune` file and is
// EXPANDED AT RUNTIME. chrono can't produce RRULEs, so this module is a small
// English -> RRULE translator on top of the `rrule` package.
//
// Cadence semantics (the CALLER chooses what `fromISO` means; these functions
// just compute forward from whatever they are given):
//   recur:  "every other monday"  — FIXED cadence. The caller passes the
//           SCHEDULED/due date as `fromISO`, so the series is anchored to the
//           plan and a late completion does not shift it.
//   recur!: "every 3 days"        — ROLLING cadence. The caller passes the
//           COMPLETION date as `fromISO`, so the next occurrence rolls forward
//           from when the task was actually finished.
// In both cases `fromISO` is the anchor and we return dates strictly after it.
//
//   nextOccurrence(rule, fromISO): the next date strictly after fromISO (ISO
//     `YYYY-MM-DD`), or null if the rule does not parse.
//   expand(rule, fromISO, count): up to `count` future occurrences (ISO dates),
//     all strictly after fromISO, or [] if the rule does not parse.

import { RRule, type Options, type Weekday } from 'rrule';

/** Map an English weekday word (full or 3-letter, case-insensitive) to RRule. */
const WEEKDAYS: Record<string, Weekday> = {
  monday: RRule.MO,
  mon: RRule.MO,
  tuesday: RRule.TU,
  tue: RRule.TU,
  tues: RRule.TU,
  wednesday: RRule.WE,
  wed: RRule.WE,
  thursday: RRule.TH,
  thu: RRule.TH,
  thur: RRule.TH,
  thurs: RRule.TH,
  friday: RRule.FR,
  fri: RRule.FR,
  saturday: RRule.SA,
  sat: RRule.SA,
  sunday: RRule.SU,
  sun: RRule.SU,
};

/** Map a unit word (singular or plural) to an RRule frequency. */
const UNIT_FREQ: Record<string, RRule['options']['freq']> = {
  day: RRule.DAILY,
  days: RRule.DAILY,
  daily: RRule.DAILY,
  week: RRule.WEEKLY,
  weeks: RRule.WEEKLY,
  weekly: RRule.WEEKLY,
  month: RRule.MONTHLY,
  months: RRule.MONTHLY,
  monthly: RRule.MONTHLY,
  year: RRule.YEARLY,
  years: RRule.YEARLY,
  yearly: RRule.YEARLY,
  annually: RRule.YEARLY,
};

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/** The last day-of-month number (28..31) for the month `d` falls in. */
function lastDayOfMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * RRule options for "the Nth of each month, clamped to short months". A day >= 29
 * is expressed as the candidate range 28..N with `bysetpos: -1` (keep the LAST
 * matching day), so a month too short for N lands on its final day rather than
 * being dropped by rrule. N=31 therefore means true month-end (28 in Feb, 30 in
 * Apr, ...). A day <= 28 exists in every month, so it is pinned exactly.
 */
function monthDayClamp(dom: number): { bymonthday: number | number[]; bysetpos?: number } {
  if (dom >= 29) {
    const days: number[] = [];
    for (let d = 28; d <= dom; d++) days.push(d);
    return { bymonthday: days, bysetpos: -1 };
  }
  return { bymonthday: dom };
}

/** Parse an ISO `YYYY-MM-DD` into a UTC-midnight Date, or null if malformed. */
function parseISO(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject impossible dates (e.g. 2026-02-31 -> rolls to March).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/** Format a UTC Date back to ISO `YYYY-MM-DD`. */
function toISO(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Translate one English recurrence phrase into RRule options (sans `dtstart`,
 * which is supplied per-call from `fromISO`). Returns null if it can't parse.
 *
 * Supported: daily/weekly/monthly/yearly; "every N <unit>"; "every other
 * <unit>"; weekday names ("every monday", "every tue,thu"); "every weekday";
 * "every month on the last"; "every year on march 1".
 */
function parseRule(rule: string): Partial<Options> | null {
  let s = rule.trim().toLowerCase();
  if (!s) return null;

  // Strip a leading "every" / "each" — the grammar is "every <something>".
  s = s.replace(/^(every|each)\s+/, '');
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // "every weekday" -> Mon–Fri, weekly.
  if (s === 'weekday' || s === 'weekdays') {
    return { freq: RRule.WEEKLY, byweekday: [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR] };
  }
  // "every day/week/month/year" handled below as bare units too, but a bare
  // "weekend" is its own thing.
  if (s === 'weekend' || s === 'weekends') {
    return { freq: RRule.WEEKLY, byweekday: [RRule.SA, RRule.SU] };
  }

  // A comma/`and`-separated list of weekday names: "monday", "tue,thu",
  // "mon and wed". Must be ALL weekday tokens to qualify.
  const weekdayList = parseWeekdayList(s);
  if (weekdayList) {
    return { freq: RRule.WEEKLY, byweekday: weekdayList };
  }

  // "other <unit>" -> interval 2.
  const otherMatch = /^other\s+(\w+)$/.exec(s);
  if (otherMatch) {
    const word = otherMatch[1];
    const wd = WEEKDAYS[word];
    if (wd) return { freq: RRule.WEEKLY, interval: 2, byweekday: [wd] };
    const freq = UNIT_FREQ[word];
    if (freq !== undefined) return { freq, interval: 2 };
    return null;
  }

  // "N <unit>" -> interval N (e.g. "3 days", "2 weeks").
  const nMatch = /^(\d+)\s+(\w+)$/.exec(s);
  if (nMatch) {
    const interval = Number(nMatch[1]);
    const freq = UNIT_FREQ[nMatch[2]];
    if (interval >= 1 && freq !== undefined) return { freq, interval };
    return null;
  }

  // "<unit> on the last" -> last day of the month (correct for Feb/30/31).
  const onTheLast = /^(month|months|monthly)\s+on\s+the\s+last(\s+day)?$/.exec(s);
  if (onTheLast) {
    return { freq: RRule.MONTHLY, bymonthday: -1 };
  }

  // "<unit> on the Nth" inside a month. A bare `bymonthday: 31` makes rrule DROP
  // every month without a 31st (Feb/Apr/Jun/Sep/Nov) — the same silent-skip bug
  // the plain-monthly clamp avoids. Mirror that clamp here: a requested day >= 29
  // that a month is too short for lands on that month's LAST day instead of being
  // skipped (via a candidate range + bysetpos=-1).
  const onTheNth = /^(month|months|monthly)\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  if (onTheNth) {
    const dayOfMonth = Number(onTheNth[2]);
    if (dayOfMonth < 1 || dayOfMonth > 31) return null;
    return { freq: RRule.MONTHLY, ...monthDayClamp(dayOfMonth) };
  }

  // "year on march 1" / "year on the 1st of march".
  const yearOn = /^(year|years|yearly|annually)\s+on\s+(.+)$/.exec(s);
  if (yearOn) {
    const md = parseMonthDay(yearOn[2]);
    if (md) return { freq: RRule.YEARLY, bymonth: md.month, bymonthday: md.day };
    return null;
  }

  // Bare unit: "day/daily", "week/weekly", "month/monthly", "year/yearly".
  const bareFreq = UNIT_FREQ[s];
  if (bareFreq !== undefined) {
    return { freq: bareFreq };
  }

  return null;
}

/**
 * Parse a list of weekday tokens separated by comma / "and" / spaces. Returns
 * the Weekday[] only if EVERY token is a weekday name; otherwise null.
 */
function parseWeekdayList(s: string): Weekday[] | null {
  // Split on comma / slash / "and" / plain spaces, so "mon wed", "mon,wed",
  // "mon and wed" and "mon/wed" all parse. (The `\s+and\s+` alternative is tried
  // before the bare `\s+`, so "and" is consumed, not left as a lone token.) The
  // all-tokens-must-be-weekdays guard below means non-weekday phrases like
  // "3 days" or "other monday" still fall through to their own branches.
  const tokens = s
    .split(/[,/]|\s+and\s+|\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const out: Weekday[] = [];
  for (const tok of tokens) {
    const wd = WEEKDAYS[tok];
    if (!wd) return null;
    out.push(wd);
  }
  return out;
}

/** Parse "march 1", "1 march", "march 1st", "the 1st of march" -> {month,day}. */
function parseMonthDay(text: string): { month: number; day: number } | null {
  const s = text.replace(/^the\s+/, '').trim();

  // "march 1" / "march 1st"
  let m = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  if (m) {
    const month = MONTHS[m[1]];
    const day = Number(m[2]);
    if (month && day >= 1 && day <= 31) return { month, day };
    return null;
  }

  // "1 march" / "1st march" / "1st of march"
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    const month = MONTHS[m[2]];
    if (month && day >= 1 && day <= 31) return { month, day };
    return null;
  }

  return null;
}

/**
 * Build a configured RRule for `rule` anchored at `fromISO`, or null if either
 * the rule or the date does not parse. `dtstart` is the anchor; for plain
 * monthly/yearly without an explicit day we pin the day-of-month to the anchor
 * so e.g. "monthly" from the 15th lands on the 15th.
 */
function buildRule(rule: string, fromISO: string): RRule | null {
  const dtstart = parseISO(fromISO);
  if (!dtstart) return null;
  const opts = parseRule(rule);
  if (!opts) return null;

  // Plain MONTHLY with no day pin: anchor to the start day so the cadence tracks
  // the anchor date rather than rrule's default. Short months are CLAMPED to
  // their last day (never skipped) via monthDayClamp.
  if (opts.freq === RRule.MONTHLY && opts.bymonthday === undefined && opts.byweekday === undefined) {
    const day = dtstart.getUTCDate();
    // Month-end RETENTION under re-anchoring. The store recomputes `every month`
    // from each produced date, so Jan 31 -> Feb 28; if Feb 28 were then treated
    // as a plain "28th" the series would decay to the 28th forever (Feb 28 ->
    // Mar 28 -> ...). Instead: when the anchor IS the last day of its month and
    // that day is < 31 (i.e. a clamped month-end such as Feb 28 or Apr 30), read
    // it as still meaning month-end, so re-anchoring returns to the true last day
    // (Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31 ...), matching Todoist.
    // Tradeoff (documented): a genuine "28th" that lands on Feb 28 while
    // re-anchoring will thereafter snap to month-end — an accepted edge case.
    const isLastDay = day === lastDayOfMonth(dtstart);
    const effectiveDom = isLastDay && day < 31 ? 31 : day;
    Object.assign(opts, monthDayClamp(effectiveDom));
  }
  // Plain YEARLY with no month/day pin: anchor to the start month+day.
  if (opts.freq === RRule.YEARLY && opts.bymonth === undefined && opts.bymonthday === undefined) {
    opts.bymonth = dtstart.getUTCMonth() + 1;
    opts.bymonthday = dtstart.getUTCDate();
  }

  try {
    return new RRule({ ...opts, dtstart });
  } catch {
    return null;
  }
}

/** The next occurrence strictly after `fromISO`, as `YYYY-MM-DD`, or null. */
export function nextOccurrence(rule: string, fromISO: string): string | null {
  const rr = buildRule(rule, fromISO);
  if (!rr) return null;
  const from = parseISO(fromISO);
  if (!from) return null;
  const next = rr.after(from, false); // inc=false => strictly after
  return next ? toISO(next) : null;
}

/** Up to `count` future occurrences from `fromISO`, as `YYYY-MM-DD` strings. */
export function expand(rule: string, fromISO: string, count = 10): string[] {
  if (count <= 0) return [];
  const rr = buildRule(rule, fromISO);
  if (!rr) return [];
  const from = parseISO(fromISO);
  if (!from) return [];

  const out: string[] = [];
  const fromMs = from.getTime();
  // Iterate the series, collecting only occurrences strictly after the anchor.
  // The iterator returns false to stop once we have `count` of them, which
  // bounds the work even for far-future or dense rules.
  rr.all((d): boolean => {
    if (d.getTime() > fromMs) out.push(toISO(d));
    return out.length < count;
  });
  return out;
}
