// Date formatting + natural-language parsing.
//
// Storage form is always ISO `YYYY-MM-DD` (BRIEF §2). chrono-node parses
// free-form input with forwardDate:true (a todo is virtually never due in the
// past). date-fns formats the stored ISO back into short human words for the
// quiet inline meta and the quick-add preview echo.

import * as chrono from 'chrono-node';
import { format, isValid, parseISO } from 'date-fns';

/** A parsed date result: the canonical ISO date plus the source text span chrono
 *  matched, so the quick-add bar can strike the recognized phrase. */
export interface ParsedDate {
  /** `YYYY-MM-DD`. */
  iso: string;
  /** The exact substring chrono matched, e.g. "next friday". */
  text: string;
  /** Start offset of the match within the input. */
  index: number;
  /** Whether a time-of-day was present (assumed PM etc. render in mute ink). */
  hasTime: boolean;
}

/** Parse the FIRST date phrase found anywhere in `input`. forwardDate is on. */
export function parseDate(input: string, ref: Date = new Date()): ParsedDate | null {
  const results = chrono.parse(input, ref, { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  const d = r.start.date();
  if (!isValid(d)) return null;
  return {
    iso: toISO(d),
    text: r.text,
    index: r.index,
    hasTime: r.start.isCertain('hour'),
  };
}

/** Parse a phrase that MUST be a date (used by the `due `/`start ` override). */
export function parseDateStrict(phrase: string, ref: Date = new Date()): string | null {
  const d = chrono.parseDate(phrase, ref, { forwardDate: true });
  return d && isValid(d) ? toISO(d) : null;
}

/** A Date -> `YYYY-MM-DD` (local date, no timezone shift). */
export function toISO(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

/** ISO `YYYY-MM-DD` -> short human words, e.g. "Jul 10". Year appended when it
 *  differs from the current year. Returns the raw string unchanged if it is not
 *  a parseable ISO date (preserved-but-ignored values stay literal). */
export function formatShort(iso: string, now: Date = new Date()): string {
  const d = parseISO(iso);
  if (!isValid(d)) return iso;
  return d.getFullYear() === now.getFullYear()
    ? format(d, 'MMM d')
    : format(d, 'MMM d yyyy');
}

/** Echo a date in words for the quick-add preview, e.g. "Fri Jul 3". */
export function echoWords(iso: string): string {
  const d = parseISO(iso);
  if (!isValid(d)) return iso;
  return format(d, 'EEE MMM d');
}

/** True if `iso` is strictly before the local date of `now` (overdue). Only a
 *  valid ISO date can be overdue; anything else is never flagged. */
export function isOverdue(iso: string, now: Date = new Date()): boolean {
  const d = parseISO(iso);
  if (!isValid(d)) return false;
  return toISO(d) < toISO(now);
}

/** True if `iso` is on or before the local date of `now` (due today incl.
 *  overdue) — the Today/Agenda predicate. */
export function isOnOrBefore(iso: string, now: Date): boolean {
  return isOnOrBeforeISO(iso, toISO(now));
}

/** String-only variant of {@link isOnOrBefore}: true if the date `iso` is on or
 *  before the plain `YYYY-MM-DD` local date `nowDate`. Both sides are compared
 *  as canonical ISO date strings, so there is NO `new Date(dateOnlyString)` UTC
 *  round-trip — the pitfall that made Today collapse to yesterday west of UTC.
 *  `iso` is validated (only a real ISO date can match); `nowDate` is trusted to
 *  already be a local `YYYY-MM-DD` (e.g. from `toISO(now)`). */
export function isOnOrBeforeISO(iso: string, nowDate: string): boolean {
  const d = parseISO(iso);
  if (!isValid(d)) return false;
  // toISO(d) re-canonicalises `iso` (parseISO treats a date-only string as LOCAL
  // midnight, so no zone shift). Lexicographic <= over YYYY-MM-DD is chronological.
  return toISO(d) <= nowDate.slice(0, 10);
}
