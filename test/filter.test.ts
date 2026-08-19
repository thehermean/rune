// The `/` Document-view filter — pure matcher tests (web/lib/filter.ts).
//
// The filter query IS the capture grammar: compileFilter() runs it through the
// same parseInput() the quick-add bar uses, so `#finance` means tag, `@home`
// means context, `!!!` means priority ≥ 3, bare words substring-match titles,
// and `overdue` / `due:<date>` constrain by date. These tests exercise the
// matcher entirely without a DOM.

import { describe, it, expect } from 'vitest';
import { parse, tasks } from '../src/index';
import type { TaskNode } from '../src/types';
import { compileFilter, matchesFilter, taskMatchesQuery } from '../web/lib/filter';

/** Parse one task line into a TaskNode. */
function task(line: string): TaskNode {
  const t = tasks(parse(line))[0];
  if (!t) throw new Error(`not a task line: ${line}`);
  return t;
}

// A fixed "now" so overdue/due bounds are deterministic: local 2026-07-02.
const NOW = new Date(2026, 6, 2, 10, 0, 0);

function matches(line: string, query: string): boolean {
  return matchesFilter(task(line), compileFilter(query, NOW), NOW);
}

describe('compileFilter — the query is the capture grammar', () => {
  it('an empty / whitespace query compiles empty and matches everything', () => {
    expect(compileFilter('', NOW).isEmpty).toBe(true);
    expect(compileFilter('   ', NOW).isEmpty).toBe(true);
    expect(matches('- [ ] anything at all ^t-a', '')).toBe(true);
  });

  it('#tag, @context, !!! and bare words land in their own buckets', () => {
    const f = compileFilter('pay #finance @home !!!', NOW);
    expect(f.tags).toEqual(['finance']);
    expect(f.contexts).toEqual(['home']);
    expect(f.minPriority).toBe(3);
    expect(f.words).toEqual(['pay']);
    expect(f.isEmpty).toBe(false);
  });

  it('`overdue` is consumed as a term, not a title word', () => {
    const f = compileFilter('overdue', NOW);
    expect(f.overdue).toBe(true);
    expect(f.words).toEqual([]);
  });
});

describe('matchesFilter — tags and contexts', () => {
  it('#tag requires the tag', () => {
    expect(matches('- [ ] Pay invoice #finance ^t-a', '#finance')).toBe(true);
    expect(matches('- [ ] Walk dog #home ^t-b', '#finance')).toBe(false);
  });

  it('a parent tag matches its nested children (#rune -> #rune/release)', () => {
    expect(matches('- [ ] Ship parser #rune/release ^t-a', '#rune')).toBe(true);
    expect(matches('- [ ] Ship parser #rune/release ^t-a', '#rune/release')).toBe(true);
    expect(matches('- [ ] Other #runway ^t-b', '#rune')).toBe(false);
  });

  it('@context requires the context (case-insensitive)', () => {
    expect(matches('- [ ] Review with @Alice ^t-a', '@alice')).toBe(true);
    expect(matches('- [ ] Solo work ^t-b', '@alice')).toBe(false);
  });

  it('multiple sigil terms AND together', () => {
    const line = '- [ ] Pay invoice #finance @desk ^t-a';
    expect(matches(line, '#finance @desk')).toBe(true);
    expect(matches(line, '#finance @home')).toBe(false);
  });
});

describe('matchesFilter — priority', () => {
  it('!!! means priority >= 3; !! means >= 2', () => {
    expect(matches('- [ ] Urgent !!! ^t-a', '!!!')).toBe(true);
    expect(matches('- [ ] Mild !! ^t-b', '!!!')).toBe(false);
    expect(matches('- [ ] Urgent !!! ^t-a', '!!')).toBe(true);
    expect(matches('- [ ] Calm ^t-c', '!')).toBe(false);
  });
});

describe('matchesFilter — bare words match titles', () => {
  it('substring, case-insensitive', () => {
    expect(matches('- [ ] Pay AWS invoice ^t-a', 'aws')).toBe(true);
    expect(matches('- [ ] Pay AWS invoice ^t-a', 'invoi')).toBe(true);
    expect(matches('- [ ] Pay AWS invoice ^t-a', 'rent')).toBe(false);
  });

  it('every word must match (AND)', () => {
    expect(matches('- [ ] Pay AWS invoice ^t-a', 'pay invoice')).toBe(true);
    expect(matches('- [ ] Pay AWS invoice ^t-a', 'pay rent')).toBe(false);
  });

  it('words match the TITLE, not tag/id text', () => {
    // "finance" appears only as a tag; a bare word must not match it.
    expect(matches('- [ ] Pay invoice #finance ^t-a', 'finance')).toBe(false);
  });
});

describe('matchesFilter — dates', () => {
  it('`overdue` matches only past-due dated tasks', () => {
    expect(matches('- [ ] Old due:2026-07-01 ^t-a', 'overdue')).toBe(true);
    expect(matches('- [ ] Today due:2026-07-02 ^t-b', 'overdue')).toBe(false);
    expect(matches('- [ ] Future due:2026-08-01 ^t-c', 'overdue')).toBe(false);
    expect(matches('- [ ] Undated ^t-d', 'overdue')).toBe(false);
  });

  it('overdue also honours scheduled:', () => {
    expect(matches('- [ ] Slipped scheduled:2026-06-30 ^t-a', 'overdue')).toBe(true);
  });

  it('due:<ISO> bounds to on-or-before that date', () => {
    expect(matches('- [ ] A due:2026-07-01 ^t-a', 'due:2026-07-02')).toBe(true);
    expect(matches('- [ ] B due:2026-07-02 ^t-b', 'due:2026-07-02')).toBe(true);
    expect(matches('- [ ] C due:2026-07-09 ^t-c', 'due:2026-07-02')).toBe(false);
    expect(matches('- [ ] D undated ^t-d', 'due:2026-07-02')).toBe(false);
  });

  it('natural-language date terms normalise through the capture grammar', () => {
    // "due today" resolves (via chrono, ref = NOW) to 2026-07-02.
    expect(matches('- [ ] A due:2026-07-02 ^t-a', 'due today')).toBe(true);
    expect(matches('- [ ] B due:2026-07-10 ^t-b', 'due today')).toBe(false);
  });
});

describe('matchesFilter — combinations and the convenience wrapper', () => {
  it('tag + word + priority all constrain together', () => {
    const line = '- [ ] Pay AWS invoice #finance !!! due:2026-07-01 ^t-a';
    expect(matches(line, 'invoice #finance !!!')).toBe(true);
    expect(matches(line, 'invoice #finance !!! @desk')).toBe(false);
  });

  it('taskMatchesQuery compiles and tests in one call', () => {
    expect(taskMatchesQuery(task('- [ ] Pay rent #home ^t-a'), '#home', NOW)).toBe(true);
    expect(taskMatchesQuery(task('- [ ] Pay rent #home ^t-a'), '#work', NOW)).toBe(false);
  });
});
