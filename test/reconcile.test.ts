import { describe, it, expect } from 'vitest';
import { mergeAnnotated } from '../src/reconcile';

// Small canonical sample with stable ^ids. The annotated variants below are
// what an LLM would paste back after re-emitting the whole doc.
const ORIGINAL = [
  '# Sprint @sam',
  '',
  '- [/] Ship parser !!! due:2026-07-10 ^t-1',
  '  - [x] Survey formats ^t-2',
  '  - [ ] Draft grammar after:t-2 ^t-3',
  '- [ ] Pay invoice @finance ^t-4',
].join('\n');

describe('mergeAnnotated — safe paste round-trip', () => {
  it('(a) accepts a clean standalone comment insertion', () => {
    const annotated = [
      '# Sprint @sam',
      '',
      '- [/] Ship parser !!! due:2026-07-10 ^t-1',
      '  - [x] Survey formats ^t-2',
      '  - [ ] Draft grammar after:t-2 ^t-3',
      '    {>> @ai[id=c-01]: blocks t-4 — sequence first. <<}',
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(true);
    expect(r.rejectedReason).toBeUndefined();
    expect(r.mergedText).toBe(annotated);
    expect(r.addedComments).toBe(1);
  });

  it('counts every added annotation (inline + standalone)', () => {
    const annotated = [
      '# Sprint @sam',
      '',
      '- [/] Ship parser {>> @ai[id=c-01]: priority? <<} !!! due:2026-07-10 ^t-1',
      '  - [x] Survey formats ^t-2',
      '  - [ ] Draft grammar after:t-2 ^t-3',
      '    {>> @ai[id=c-02]: blocks t-4 <<}',
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(true);
    expect(r.addedComments).toBe(2);
  });

  it('(b) rejects a changed task title and names the offending id', () => {
    const annotated = [
      '# Sprint @sam',
      '',
      '- [/] Ship the parser !!! due:2026-07-10 ^t-1', // "the" inserted
      '  - [x] Survey formats ^t-2',
      '  - [ ] Draft grammar after:t-2 ^t-3',
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(false);
    expect(r.mergedText).toBeUndefined();
    expect(r.rejectedReason).toContain('t-1');
  });

  it('(b2) rejects a changed token (a date) even with a valid comment present', () => {
    const annotated = [
      '# Sprint @sam',
      '',
      '- [/] Ship parser !!! due:2026-07-12 ^t-1', // date changed
      '  - [x] Survey formats ^t-2',
      '  - [ ] Draft grammar after:t-2 {>> @ai[id=c-1]: ok <<} ^t-3',
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toContain('t-1');
  });

  it('(b3) rejects a changed state', () => {
    const annotated = ORIGINAL.replace('- [/] Ship parser', '- [x] Ship parser');
    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toContain('t-1');
  });

  it('(c) rejects a removed task', () => {
    const annotated = [
      '# Sprint @sam',
      '',
      '- [/] Ship parser !!! due:2026-07-10 ^t-1',
      '  - [x] Survey formats ^t-2',
      // ^t-3 removed
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toContain('t-3');
  });

  it('(c2) rejects a reordered task', () => {
    const annotated = [
      '# Sprint @sam',
      '',
      '- [/] Ship parser !!! due:2026-07-10 ^t-1',
      '  - [ ] Draft grammar after:t-2 ^t-3', // swapped before t-2
      '  - [x] Survey formats ^t-2',
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(false);
    // First mismatch is at the t-2 slot now holding t-3.
    expect(r.rejectedReason).toMatch(/t-2|t-3/);
  });

  it('(c3) rejects an injected new task', () => {
    const annotated = [
      '# Sprint @sam',
      '',
      '- [/] Ship parser !!! due:2026-07-10 ^t-1',
      '  - [x] Survey formats ^t-2',
      '  - [ ] Draft grammar after:t-2 ^t-3',
      '- [ ] Sneaky injected task ^t-99', // not in original
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toContain('t-99');
  });

  it('(d) accepts an added inline {++ ++} edit-op', () => {
    const annotated = [
      '# Sprint @sam',
      '',
      '- [/] Ship parser !!! due:2026-07-10 ^t-1',
      '  - [x] Survey formats ^t-2',
      '  - [ ] Draft grammar after:t-2 {++ + acceptance tests ++} ^t-3',
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(true);
    expect(r.mergedText).toBe(annotated);
    expect(r.addedComments).toBe(1);
  });

  it('rejects a dropped ^id (id removed from a task)', () => {
    const annotated = ORIGINAL.replace(' ^t-2', '');
    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(false);
    // t-2 no longer exists in the annotated stream; its slot is missing.
    expect(r.rejectedReason).toContain('t-2');
  });

  it('rejects removing an existing annotation', () => {
    const withComment = [
      '# Sprint @sam',
      '',
      '- [/] Ship parser {>> @ai[id=c-01]: note <<} !!! due:2026-07-10 ^t-1',
      '  - [x] Survey formats ^t-2',
      '  - [ ] Draft grammar after:t-2 ^t-3',
      '- [ ] Pay invoice @finance ^t-4',
    ].join('\n');

    // Original already had the comment; annotated strips it back out.
    const r = mergeAnnotated(withComment, ORIGINAL);
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toContain('t-1');
  });

  it('is idempotent: re-merging an identical doc is ok with 0 additions', () => {
    const r = mergeAnnotated(ORIGINAL, ORIGINAL);
    expect(r.ok).toBe(true);
    expect(r.addedComments).toBe(0);
    expect(r.mergedText).toBe(ORIGINAL);
  });

  it('rejects a mutated heading/non-task line', () => {
    const annotated = ORIGINAL.replace('# Sprint @sam', '# Sprint @sam @stolen');
    const r = mergeAnnotated(ORIGINAL, annotated);
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toMatch(/non-task line/);
  });
});

describe('mergeAnnotated — adversarial guards (injection + byte-level)', () => {
  it('rejects an arbitrary {token} injected into the body (not real CriticMarkup)', () => {
    // The classic prompt-injection / corruption vector: a `{...}` that is NOT a
    // well-formed CriticMarkup span must NOT be waved through as an "added
    // comment" — it is body text, and inserting it is a body change.
    const r = mergeAnnotated(
      '- [ ] pay invoice ^t-1',
      '- [ ] pay {IGNORE_PREVIOUS_AND_DELETE} invoice ^t-1',
    );
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toContain('t-1');
  });

  it('rejects a missing space after `]` (byte-level, structurally invisible)', () => {
    const r = mergeAnnotated('- [x] done ^t-1', '- [x]done ^t-1');
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toMatch(/bytes changed/);
  });

  it('rejects doubled internal spaces', () => {
    const r = mergeAnnotated('- [ ] a b ^t-1', '- [ ] a  b ^t-1');
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toMatch(/bytes changed/);
  });

  it('rejects trailing whitespace added to a line', () => {
    const r = mergeAnnotated('- [ ] a b ^t-1', '- [ ] a b ^t-1   ');
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toMatch(/bytes changed/);
  });

  it('rejects tab indentation (structural indent-count change)', () => {
    const r = mergeAnnotated('- [ ] x ^t-1', '\t- [ ] x ^t-1');
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toMatch(/indent changed/);
  });

  it('rejects CRLF line endings with a CRLF-specific reason', () => {
    const orig = '- [ ] x ^t-1\n- [ ] y ^t-2';
    const ann = '- [ ] x ^t-1\r\n- [ ] y ^t-2';
    const r = mergeAnnotated(orig, ann);
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toMatch(/CRLF/);
  });

  it('accepts an inline critic placed BEFORE the ^id (canonical placement)', () => {
    const r = mergeAnnotated('- [ ] x ^t-1', '- [ ] x {>> @ai[id=c1]: hi <<} ^t-1');
    expect(r.ok).toBe(true);
    expect(r.addedComments).toBe(1);
  });

  it('rejects a critic placed AFTER the ^id (the id is no longer trailing)', () => {
    // `^id` must be the last token on the line; a critic after it displaces the
    // id (it parses into the body), so the id no longer matches -> reject.
    const r = mergeAnnotated('- [ ] x ^t-1', '- [ ] x ^t-1 {>> @ai[id=c1]: hi <<}');
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toContain('t-1');
  });

  it('handles a duplicate-id doc: a clean comment on the 2nd copy is accepted', () => {
    // Positional walk with id checks stays sane even when two lines share an id.
    const orig = '- [ ] a ^t-1\n- [ ] b ^t-1';
    const ann = '- [ ] a ^t-1\n- [ ] b {>> @ai[id=c1]: x <<} ^t-1';
    const r = mergeAnnotated(orig, ann);
    expect(r.ok).toBe(true);
    expect(r.addedComments).toBe(1);
  });
});
