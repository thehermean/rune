import { describe, it, expect } from 'vitest';
import { parse, serialize } from '../src/index';
import { comments, commentsFor } from '../src/criticmarkup';
import {
  insertComment,
  setCommentResolved,
  nextCommentId,
} from '../web/lib/edit';

// These exercise the pure comment helpers added to web/lib/edit.ts in the Core
// phase. The contract is the same as the rest of the editing layer: parse .rune
// TEXT -> transform -> serialize, with the input Doc NEVER mutated. We assert on
// the serialized text where the exact bytes matter, and round-trip back through
// criticmarkup.comments() to prove the inserted line re-parses to the intended
// Comment (correct anchoring, author, threading, resolved flag).

describe('insertComment', () => {
  it('inserts a standalone comment line at task.indent+2, anchored to the task', () => {
    const src = ['- [ ] Task ^t-1', '- [ ] Other ^t-2'].join('\n');

    const out = serialize(
      insertComment(parse(src), 't-1', {
        author: 'ai',
        commentId: 'c-1',
        body: 'hello world',
      }),
    );

    expect(out).toBe(
      [
        '- [ ] Task ^t-1',
        '  {>> @ai[id=c-1]: hello world <<}',
        '- [ ] Other ^t-2',
      ].join('\n'),
    );
  });

  it('indents the comment to the (deeper) task indent + 2', () => {
    const src = ['- [ ] Top ^t-1', '  - [ ] Child ^t-2'].join('\n');

    const out = serialize(
      insertComment(parse(src), 't-2', {
        author: 'a',
        commentId: 'c-1',
        body: 'note',
      }),
    );

    // Child is at indent 2, so its comment lands at indent 4.
    expect(out).toBe(
      [
        '- [ ] Top ^t-1',
        '  - [ ] Child ^t-2',
        '    {>> @a[id=c-1]: note <<}',
      ].join('\n'),
    );
  });

  it('round-trips: the inserted line re-parses to the intended Comment', () => {
    const next = insertComment(parse('- [ ] Task ^t-1'), 't-1', {
      author: 'ai',
      commentId: 'c-1',
      body: 'hello world',
    });

    const parsed = commentsFor(next, 't-1');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      commentId: 'c-1',
      author: 'ai',
      body: 'hello world',
      itemId: 't-1',
      kind: 'comment',
    });
  });

  it('carries reply= in the head and threads to the parent comment', () => {
    const src = [
      '- [ ] Task ^t-1',
      '  {>> @ai[id=c-1]: hello world <<}',
    ].join('\n');

    const next = insertComment(parse(src), 't-1', {
      author: 'sam',
      commentId: 'c-2',
      reply: 'c-1',
      body: 'a reply',
    });

    // The new reply is placed directly after the existing comment under t-1, so
    // the thread stays contiguous and both still anchor to t-1.
    expect(serialize(next)).toBe(
      [
        '- [ ] Task ^t-1',
        '  {>> @ai[id=c-1]: hello world <<}',
        '  {>> @sam[id=c-2 reply=c-1]: a reply <<}',
      ].join('\n'),
    );

    const reply = commentsFor(next, 't-1').find((c) => c.commentId === 'c-2');
    expect(reply?.reply).toBe('c-1');
    expect(reply?.itemId).toBe('t-1');
  });

  it('emits the bare `resolved` flag when opts.resolved is true', () => {
    const next = insertComment(parse('- [ ] T ^t-9'), 't-9', {
      author: 'a',
      commentId: 'c-1',
      body: 'x',
      resolved: true,
    });

    expect(serialize(next)).toBe(
      ['- [ ] T ^t-9', '  {>> @a[id=c-1 resolved]: x <<}'].join('\n'),
    );
    expect(commentsFor(next, 't-9')[0]?.resolved).toBe(true);
  });

  it('sanitizes the body: collapses newlines and defuses critic delimiters', () => {
    const next = insertComment(parse('- [ ] T ^t-9'), 't-9', {
      author: 'a',
      commentId: 'c-1',
      body: 'line1\nline2  <<} {>> end',
    });

    // Newlines/runs collapse to single spaces; `<<}` and `{>>` are defused with a
    // hairline space so they cannot close/open the block early.
    expect(serialize(next)).toBe(
      ['- [ ] T ^t-9', '  {>> @a[id=c-1]: line1 line2 << } { >> end <<}'].join(
        '\n',
      ),
    );

    // The defusing means the whole thing parses as a SINGLE comment block whose
    // body survives intact (no early close, no nested open).
    const parsed = commentsFor(next, 't-9');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].body).toBe('line1 line2 << } { >> end');
  });

  it('places a new comment after existing notes/comments but before a trailing blank', () => {
    const src = [
      '- [ ] T ^t-1',
      '  {>> @a[id=c-1]: existing <<}',
      '',
      '- [ ] Next ^t-2',
    ].join('\n');

    const out = serialize(
      insertComment(parse(src), 't-1', {
        author: 'b',
        commentId: 'c-2',
        body: 'new',
      }),
    );

    // The new line hangs after the existing comment and BEFORE the blank line,
    // keeping the thread contiguous and still anchored to t-1.
    expect(out).toBe(
      [
        '- [ ] T ^t-1',
        '  {>> @a[id=c-1]: existing <<}',
        '  {>> @b[id=c-2]: new <<}',
        '',
        '- [ ] Next ^t-2',
      ].join('\n'),
    );
  });

  it('falls back to a default author when sanitizing empties it (id must survive)', () => {
    // An author of only illegal chars sanitizes to '' -> `@[id=…]` which HEAD_RE
    // cannot parse, leaking the head into the body and LOSING the commentId.
    // Guard: default the author so the head parses and the id survives.
    const next = insertComment(parse('- [ ] Task ^t-1'), 't-1', {
      author: '@@@',
      commentId: 'c-7',
      body: 'kept',
    });

    // The emitted head has a real author, not a bare `@[`.
    expect(serialize(next)).toBe(
      ['- [ ] Task ^t-1', '  {>> @me[id=c-7]: kept <<}'].join('\n'),
    );
    // And it re-parses to the intended comment (id NOT lost to the body).
    const parsed = commentsFor(next, 't-1');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].commentId).toBe('c-7');
    expect(parsed[0].body).toBe('kept');
  });

  it('leaves the doc unchanged (new object) for an unknown task id', () => {
    const src = ['- [ ] Only ^t-1'].join('\n');
    const doc = parse(src);

    const next = insertComment(doc, 'missing', {
      author: 'a',
      commentId: 'c-1',
      body: 'x',
    });

    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
    expect(next.nodes).not.toBe(doc.nodes);
  });

  it('leaves the doc unchanged for an empty/whitespace-only body', () => {
    const src = ['- [ ] T ^t-1'].join('\n');
    const doc = parse(src);

    const next = insertComment(doc, 't-1', {
      author: 'a',
      commentId: 'c-1',
      body: '   \n  ',
    });

    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
  });

  it('leaves the doc unchanged for an empty/whitespace-only commentId', () => {
    const src = ['- [ ] T ^t-1'].join('\n');
    const doc = parse(src);

    const next = insertComment(doc, 't-1', {
      author: 'a',
      commentId: '   ',
      body: 'x',
    });

    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
  });

  it('never mutates the input Doc', () => {
    const doc = parse('- [ ] Task ^t-1');
    const before = serialize(doc);
    const beforeLen = doc.nodes.length;

    insertComment(doc, 't-1', { author: 'a', commentId: 'c-1', body: 'x' });

    expect(serialize(doc)).toBe(before);
    expect(doc.nodes).toHaveLength(beforeLen);
  });
});

describe('setCommentResolved', () => {
  const SRC = [
    '- [ ] Task ^t-1',
    '  {>> @ai[id=c-1 reply=c-0]: body here <<}',
  ].join('\n');

  it('adds the bare `resolved` flag, leaving the rest byte-identical', () => {
    const out = serialize(setCommentResolved(parse(SRC), 'c-1', true));

    expect(out).toBe(
      [
        '- [ ] Task ^t-1',
        '  {>> @ai[id=c-1 reply=c-0 resolved]: body here <<}',
      ].join('\n'),
    );
    expect(commentsFor(parse(out), 't-1')[0]?.resolved).toBe(true);
  });

  it('removes the `resolved` flag when set to false', () => {
    const resolved = [
      '- [ ] Task ^t-1',
      '  {>> @ai[id=c-1 reply=c-0 resolved]: body here <<}',
    ].join('\n');

    const out = serialize(setCommentResolved(parse(resolved), 'c-1', false));

    expect(out).toBe(SRC);
    expect(commentsFor(parse(out), 't-1')[0]?.resolved).toBeFalsy();
  });

  it('is a no-op (new object) when already in the requested state', () => {
    const doc = parse(SRC);

    // Already unresolved; setting false changes nothing.
    const next = setCommentResolved(doc, 'c-1', false);
    expect(serialize(next)).toBe(SRC);
    expect(next).not.toBe(doc);
    expect(next.nodes).not.toBe(doc.nodes);
  });

  it('touches only the addressed comment when several share a thread', () => {
    const src = [
      '- [ ] Task ^t-1',
      '  {>> @ai[id=c-1]: first <<}',
      '  {>> @sam[id=c-2]: second <<}',
    ].join('\n');

    const out = serialize(setCommentResolved(parse(src), 'c-2', true));

    expect(out).toBe(
      [
        '- [ ] Task ^t-1',
        '  {>> @ai[id=c-1]: first <<}',
        '  {>> @sam[id=c-2 resolved]: second <<}',
      ].join('\n'),
    );
  });

  it('leaves the doc unchanged (new object) for an unknown comment id', () => {
    const doc = parse(SRC);

    const next = setCommentResolved(doc, 'nope', true);

    expect(serialize(next)).toBe(SRC);
    expect(next).not.toBe(doc);
    expect(next.nodes).not.toBe(doc.nodes);
  });

  it('does not touch an inline-only comment (only standalone lines are rewritable)', () => {
    const src = '- [/] Draft {>> @sam[id=c-1]: inline <<} ^t-1';
    const doc = parse(src);

    const next = setCommentResolved(doc, 'c-1', true);

    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
  });

  it('never mutates the input Doc', () => {
    const doc = parse(SRC);

    setCommentResolved(doc, 'c-1', true);

    expect(serialize(doc)).toBe(SRC);
  });
});

describe('nextCommentId', () => {
  it('returns c-1 for a doc with no comments', () => {
    expect(nextCommentId(parse('- [ ] Task ^t-1'))).toBe('c-1');
  });

  it('skips ids used by BOTH inline and standalone comments', () => {
    const doc = parse(
      [
        '- [/] Draft {>> @sam[id=c-1]: inline <<} ^t-1',
        '- [ ] Ship ^t-2',
        '  {>> @ai[id=c-2]: standalone <<}',
      ].join('\n'),
    );

    expect(nextCommentId(doc)).toBe('c-3');
  });

  it('fills the lowest gap rather than always appending', () => {
    const doc = parse(
      [
        '- [ ] T ^t-1',
        '  {>> @a[id=c-1]: x <<}',
        '  {>> @a[id=c-3]: y <<}',
      ].join('\n'),
    );

    // c-1 and c-3 are taken; c-2 is the first unused 1-based id.
    expect(nextCommentId(doc)).toBe('c-2');
  });

  it('produces an id that insertComment can use without collision', () => {
    let doc = parse('- [ ] Task ^t-1');

    const id1 = nextCommentId(doc);
    doc = insertComment(doc, 't-1', { author: 'a', commentId: id1, body: 'one' });

    const id2 = nextCommentId(doc);
    expect(id2).not.toBe(id1);

    doc = insertComment(doc, 't-1', { author: 'b', commentId: id2, body: 'two' });

    const ids = commentsFor(doc, 't-1').map((c) => c.commentId);
    expect(ids).toEqual([id1, id2]);
    expect(new Set(ids).size).toBe(2);
  });
});
