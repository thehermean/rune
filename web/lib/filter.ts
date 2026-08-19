// Document-view filter — a grammar-driven narrowing of the visible rows.
//
// The query IS the capture grammar (BRIEF §3): we parse it with the SAME
// parseInput() the quick-add bar uses, so `#finance` filters by tag, `@home` by
// context, `!!!` by priority, `due:today` / `due friday` by date, and bare words
// substring-match the title. Two filter-only words are recognised: `overdue`
// (has a due/scheduled date in the past). Everything compiles to a pure
// predicate so it is unit-testable without any DOM.

import type { TaskNode } from '@core';
import { titleOf, tagsOf, contextsOf, priorityOf, getKey } from '@core';
import { parseInput } from './capture';
import { isOverdue, isOnOrBeforeISO } from './dates';

export interface CompiledFilter {
  /** Required tags (lower-cased, no `#`). A task must carry each (nested tags
   *  match a parent prefix: `#rune` matches `#rune/release`). */
  tags: string[];
  /** Required contexts (lower-cased, no `@`). */
  contexts: string[];
  /** Minimum priority (0 = no priority constraint). */
  minPriority: number;
  /** Bare words that must each appear as a substring of the title. */
  words: string[];
  /** True when the `overdue` term was present. */
  overdue: boolean;
  /** An ISO date the task's due/scheduled must be on or before, or null. */
  dueOnOrBefore: string | null;
  /** True when the query carries no constraints (matches everything). */
  isEmpty: boolean;
}

/** Parse a filter query string into a pure {@link CompiledFilter}. */
export function compileFilter(query: string, ref: Date = new Date()): CompiledFilter {
  const c = parseInput(query, ref);

  const words: string[] = [];
  let overdue = false;
  for (const w of c.title.split(/\s+/).filter(Boolean)) {
    if (w.toLowerCase() === 'overdue') overdue = true;
    else words.push(w.toLowerCase());
  }

  // A due:/scheduled: key in the query becomes a "due on or before" bound. The
  // capture grammar already normalised any natural-language date to ISO.
  const dueOnOrBefore = c.keys.due ?? c.keys.scheduled ?? null;

  const tags = c.tags.map((t) => t.toLowerCase());
  const contexts = c.contexts.map((x) => x.toLowerCase());
  const minPriority = c.priority;

  const isEmpty =
    tags.length === 0 &&
    contexts.length === 0 &&
    minPriority === 0 &&
    words.length === 0 &&
    !overdue &&
    dueOnOrBefore === null;

  return { tags, contexts, minPriority, words, overdue, dueOnOrBefore, isEmpty };
}

/** True when `task` satisfies EVERY constraint in the compiled filter. An empty
 *  filter matches everything. Pure — no DOM, no store. */
export function matchesFilter(
  task: TaskNode,
  f: CompiledFilter,
  now: Date = new Date(),
): boolean {
  if (f.isEmpty) return true;

  if (f.tags.length > 0) {
    const taskTags = tagsOf(task).map((t) => t.toLowerCase());
    for (const tag of f.tags) {
      if (!taskTags.some((t) => t === tag || t.startsWith(tag + '/'))) return false;
    }
  }

  if (f.contexts.length > 0) {
    const taskCtx = contextsOf(task).map((c) => c.toLowerCase());
    for (const ctx of f.contexts) {
      if (!taskCtx.some((c) => c === ctx || c.startsWith(ctx + '/'))) return false;
    }
  }

  if (f.minPriority > 0 && priorityOf(task) < f.minPriority) return false;

  if (f.overdue) {
    const d = getKey(task, 'due') ?? getKey(task, 'scheduled') ?? null;
    if (!d || !isOverdue(d, now)) return false;
  }

  if (f.dueOnOrBefore) {
    const d = getKey(task, 'due') ?? getKey(task, 'scheduled') ?? null;
    if (!d || !isOnOrBeforeISO(d, f.dueOnOrBefore)) return false;
  }

  if (f.words.length > 0) {
    const title = titleOf(task).toLowerCase();
    for (const w of f.words) {
      if (!title.includes(w)) return false;
    }
  }

  return true;
}

/** Convenience: compile + test in one call (used where the compiled form isn't
 *  reused). */
export function taskMatchesQuery(task: TaskNode, query: string, now: Date = new Date()): boolean {
  return matchesFilter(task, compileFilter(query, now), now);
}
